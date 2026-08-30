import { register } from '../router.js';
import * as core from '../../core/alerts.js';

register('alert', {
  description: 'Alert tools (list, create, delete)',
  subcommands: new Map([
    ['list', {
      description: 'List active alerts',
      handler: () => core.list(),
    }],
    ['create', {
      description: 'Create a price alert',
      options: {
        price: { type: 'string', short: 'p', description: 'Price level' },
        condition: { type: 'string', short: 'c', description: 'Condition: crossing, greater_than, less_than' },
        message: { type: 'string', short: 'm', description: 'Alert message' },
      },
      handler: (opts) => core.create({
        price: Number(opts.price),
        condition: opts.condition || 'crossing',
        message: opts.message,
      }),
    }],
    ['create-script', {
      description: 'Create one Any alert() function call alert for a Pine indicator',
      options: {
        expiration: { type: 'string', description: 'Expiration preset (default: session)' },
      },
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Study name required. Usage: tv alert create-script "My Indicator"');
        return core.createScript({
          study_name: positionals.join(' '),
          expiration: opts.expiration || 'session',
        });
      },
    }],
    ['delete', {
      description: 'Delete alerts',
      options: {
        all: { type: 'boolean', description: 'Delete all alerts' },
      },
      handler: (opts) => core.deleteAlerts({ delete_all: opts.all }),
    }],
  ]),
});
