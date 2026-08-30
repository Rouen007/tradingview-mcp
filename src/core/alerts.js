/**
 * Core alert logic.
 */
import { evaluate, evaluateAsync, getClient, safeString } from '../connection.js';

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function waitForResult(expression, predicate = value => Boolean(value), timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let result;
  do {
    result = await evaluate(expression);
    if (predicate(result)) return result;
    await wait(150);
  } while (Date.now() < deadline);
  return result;
}

async function failScriptAlert(message) {
  await evaluate(`
    (function() {
      var dialog = document.querySelector('[data-qa-id="ui-lib-PopupDialog"]');
      var cancel = dialog && dialog.querySelector(
        'button[data-qa-id="cancel"], button[data-qa-id="ok-btn"], button[aria-label="Close"]'
      );
      if (cancel && cancel.offsetParent !== null) cancel.click();
    })()
  `).catch(() => {});
  throw new Error(message);
}

export async function create({ condition, price, message }) {
  const opened = await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Create Alert"]')
        || document.querySelector('[data-name="alerts"]');
      if (btn) { btn.click(); return true; }
      return false;
    })()
  `);

  if (!opened) {
    const client = await getClient();
    await client.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 1, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA' });
  }

  await new Promise(r => setTimeout(r, 1000));

  const priceSet = await evaluate(`
    (function() {
      var inputs = document.querySelectorAll('[class*="alert"] input[type="text"], [class*="alert"] input[type="number"]');
      for (var i = 0; i < inputs.length; i++) {
        var label = inputs[i].closest('[class*="row"]')?.querySelector('[class*="label"]');
        if (label && /value|price/i.test(label.textContent)) {
          var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          nativeSet.call(inputs[i], ${safeString(String(price))});
          inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      if (inputs.length > 0) {
        var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSet.call(inputs[0], ${safeString(String(price))});
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return false;
    })()
  `);

  if (message) {
    await evaluate(`
      (function() {
        var textarea = document.querySelector('[class*="alert"] textarea')
          || document.querySelector('textarea[placeholder*="message"]');
        if (textarea) {
          var nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          nativeSet.call(textarea, ${JSON.stringify(message)});
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()
    `);
  }

  await new Promise(r => setTimeout(r, 500));
  const created = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button[data-name="submit"], button');
      for (var i = 0; i < btns.length; i++) {
        if (/^create$/i.test(btns[i].textContent.trim())) { btns[i].click(); return true; }
      }
      return false;
    })()
  `);

  return { success: !!created, price, condition, message: message || '(none)', price_set: !!priceSet, source: 'dom_fallback' };
}

/**
 * Create one alert for all alert() calls emitted by a Pine indicator.
 * The caller should put the chart on the desired alert interval first.
 */
export async function createScript({ study_name, expiration = 'session' }) {
  if (!study_name) throw new Error('study_name is required');
  const before = await list();
  const beforeIds = new Set((before.alerts || []).map(a => String(a.alert_id)));

  const opened = await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Create alert"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `);
  if (!opened) throw new Error('Create alert button not found');
  const selectorOpened = await waitForResult(`
    (function() {
      var dialog = document.querySelector('[data-qa-id="ui-lib-PopupDialog"]');
      if (!dialog || dialog.offsetParent === null) return false;
      var selector = dialog.querySelector('[data-qa-id="ui-kit-disclosure-control main-series-select"]');
      if (!selector) return false;
      selector.click();
      return true;
    })()
  `);
  if (!selectorOpened) return failScriptAlert('Alert condition selector not found');
  const selected = await waitForResult(`
    (function() {
      var target = ${safeString(study_name)}.toLowerCase();
      var options = document.querySelectorAll('[role="option"]');
      for (var i = 0; i < options.length; i++) {
        if (options[i].offsetParent === null) continue;
        var title = options[i].querySelector('[data-qa-id="main-series-select-title"]');
        var text = (title ? title.textContent : options[i].textContent).trim().toLowerCase();
        if (text === target || text.indexOf(target) !== -1) {
          options[i].click();
          return { selected: true, text: text };
        }
      }
      return { selected: false };
    })()
  `, value => Boolean(value && value.selected));
  if (!selected?.selected) return failScriptAlert(`Indicator not found in alert Condition menu: ${study_name}`);
  await wait(400);

  const condition = await evaluate(`
    (function() {
      var dialog = document.querySelector('[data-qa-id="ui-lib-PopupDialog"]');
      if (!dialog || dialog.offsetParent === null) return null;
      var main = dialog.querySelector('[data-qa-id="ui-kit-disclosure-control main-series-select"]');
      var operator = dialog.querySelector('[data-qa-id="operator-dropdown"]');
      var resolution = dialog.querySelector('[data-qa-id="resolution-dropdown"]');
      return {
        study: main ? main.textContent.trim() : '',
        operator: operator ? operator.textContent.trim() : '',
        resolution: resolution ? resolution.textContent.trim().replace(/\\s+/g, ' ') : ''
      };
    })()
  `);
  if (!condition || condition.study.indexOf(study_name) === -1) {
    return failScriptAlert(`Alert dialog selected wrong study: ${condition?.study || '(missing)'}`);
  }
  if (!/Any alert\(\) function call/i.test(condition.operator)) {
    return failScriptAlert(`Expected Any alert() function call, got: ${condition.operator || '(missing)'}`);
  }
  if (!/1 minute/i.test(condition.resolution)) {
    return failScriptAlert(`Script alert must use 1 minute interval, got: ${condition.resolution || '(missing)'}`);
  }

  if (expiration === 'session') {
    const expirationOpened = await evaluate(`
      (function() {
        var dialog = document.querySelector('[data-qa-id="ui-lib-PopupDialog"]');
        var btn = dialog && dialog.querySelector('[data-qa-id="expiration-time-dropdown-button"]');
        if (!btn) return false;
        btn.click();
        return true;
      })()
    `);
    if (!expirationOpened) return failScriptAlert('Expiration selector not found');
    await wait(250);
    const expirationSelected = await evaluate(`
      (function() {
        var item = document.querySelector('[data-qa-id="expiration-time-dropdown-item-preset-session-current"]');
        if (!item || item.offsetParent === null) return false;
        item.click();
        return true;
      })()
    `);
    if (!expirationSelected) return failScriptAlert('End of trading session expiration option not found');
    await wait(250);
  }

  const submitted = await evaluate(`
    (function() {
      var dialog = document.querySelector('[data-qa-id="ui-lib-PopupDialog"]');
      var btn = dialog && dialog.querySelector('button[data-qa-id="submit"]');
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    })()
  `);
  if (!submitted) return failScriptAlert('Alert Create button not found or disabled');
  // TradingView accepts the alert before list_alerts is necessarily updated.
  // Poll long enough to capture the server-assigned id so callers can persist it
  // and avoid creating a duplicate on a later run.
  let created = null;
  for (let attempt = 0; attempt < 20 && !created; attempt += 1) {
    await wait(500);
    const after = await list();
    created = (after.alerts || []).find(a => !beforeIds.has(String(a.alert_id))) || null;
  }
  return {
    success: true,
    action: 'script_alert_created',
    study_name,
    condition: condition.operator,
    resolution: condition.resolution,
    expiration,
    alert_id: created?.alert_id || null,
    alert: created,
  };
}

export async function list() {
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            return {
              alert_id: a.alert_id,
              symbol: sym,
              type: a.type,
              message: a.message,
              active: a.active,
              condition: a.condition,
              resolution: a.resolution,
              created: a.create_time,
              last_fired: a.last_fire_time,
              expiration: a.expiration,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  return { success: true, alert_count: result?.alerts?.length || 0, source: 'internal_api', alerts: result?.alerts || [], error: result?.error };
}

export async function deleteAlerts({ delete_all }) {
  if (delete_all) {
    const result = await evaluate(`
      (function() {
        var alertBtn = document.querySelector('[data-name="alerts"]');
        if (alertBtn) alertBtn.click();
        var header = document.querySelector('[data-name="alerts"]');
        if (header) {
          header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
          return { context_menu_opened: true };
        }
        return { context_menu_opened: false };
      })()
    `);
    return { success: true, note: 'Alert deletion requires manual confirmation in the context menu.', context_menu_opened: result?.context_menu_opened || false, source: 'dom_fallback' };
  }
  throw new Error('Individual alert deletion not yet supported. Use delete_all: true.');
}
