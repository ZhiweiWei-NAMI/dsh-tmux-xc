/**
 * dsh-tmux-xc host plugin entry.
 *
 * Cordis entry: schema-validated Config, dependency injection, and `apply`
 * which opens the registry, constructs the service, and registers the agent
 * tools, owner-only client routes, and pre-step reference hooks.
 *
 * @module lib/index
 */
import z from '@deepseek-ai/schemastery';
import { TmuxXcService } from './service.js';
import { registerTools } from './tools.js';
import { registerRoutes } from './routes.js';
import { registerHooks } from './hooks.js';
import { openRegistry, memoryRegistry, unavailableRegistry } from './registry.js';
import { SOCKET_ID_RE } from './core/quote.js';

export const name = 'tmux-xc';

/**
 * Required services. `tools` drives the agent surface and `storageDomain`
 * backs the durable registry. Client routes wait for optional `connection`
 * injection; workspace attribution reads `workingDirectory` lazily per tool
 * call, so neither service needs to exist when this plugin is applied.
 */
export const inject = ['tools', 'storageDomain'];

const HOST_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const SOCKET_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

// Only SSH hosts require a validated alias. Local hosts ignore it entirely.
const HOST_TRANSPORT = z.union([
  z.object({
    transport: z.const('local').required(),
    ssh: z.string().description('ignored for local transport'),
  }),
  z.object({
    transport: z.const('ssh').default('ssh'),
    ssh: z.string().pattern(ALIAS_PATTERN).required().description('alias from the user ssh config'),
  }),
]);

export const Config = z.object({
  hosts: z
    .array(
      z.intersect([
        HOST_TRANSPORT,
        z.object({
          id: z.string().pattern(HOST_ID_PATTERN).required().description('stable host id used in references'),
          label: z.string().description('display label (defaults to id)'),
          sockets: z
            .array(
              z.object({
                id: z.string().pattern(SOCKET_ID_RE).required().description('stable socket id used in references'),
                name: z.string().pattern(SOCKET_NAME_PATTERN).description('tmux -L name'),
                path: z.string().description('tmux -S socket path (absolute POSIX)'),
              }),
            )
            .default([{ id: 'default' }]),
          newSession: z
            .object({
              command: z.array(z.string()).default([]).description('argv for new sessions; [] = tmux default-shell'),
              cwd: z.string().default('').description('default start directory'),
            })
            .default({}),
          aliases: z
            .array(
              z.object({
                session: z.string().required().description('remote session name this hint matches'),
                window: z.string().description('optional remote window name'),
                alias: z.string().required().description('display alias for the matched node'),
              }),
            )
            .default([])
            .description('display-only name hints; identity is never derived from them'),
        }),
      ]),
    )
    .default([]),
  sshPath: z.string().default('').description('path to ssh binary ("" resolves ssh on PATH)'),
  sshConfigFile: z.string().default('').description('optional -F config file (tests only)'),
  connectTimeoutSec: z.number().step(1).min(1).default(10),
  commandTimeoutMs: z.number().step(1).min(1).default(20000),
  registry: z.union(['persistent', 'memory']).default('persistent').description('memory is explicitly ephemeral; persistent failures disable operations'),
  registryScope: z.union(['user', 'profile']).default('user'),
  approval: z
    .object({
      enabled: z.boolean().default(true).description('single approval switch (default on)'),
      create: z.union(['ask', 'allow']).deprecated().description('deprecated 0.1.0 per-key override (legacy "allow" honoured)'),
      send: z.union(['ask', 'allow']).deprecated().description('deprecated 0.1.0 per-key override (legacy "allow" honoured)'),
      detach: z.union(['ask', 'allow']).deprecated().description('deprecated 0.1.0 per-key override (legacy "allow" honoured)'),
    })
    .default({}),
  send: z
    .object({
      enterDelayMs: z.number().step(1).min(0).max(5000).default(400),
    })
    .default({}),
  capture: z
    .object({
      defaultLines: z.number().step(1).min(1).default(80),
      maxLines: z.number().step(1).min(1).max(2000).default(2000),
      maxBytes: z.number().step(1).min(1).max(1024 * 1024).default(65536),
    })
    .default({}),
});

export async function apply(ctx, config) {
  const logger = ctx.logger('tmux-xc');

  // Never discard durable host pins/history as recovery from a storage failure.
  let registry;
  if (config.registry === 'memory') {
    registry = memoryRegistry();
    logger.warn('tmux-xc: explicit memory registry enabled; host pins and references will not persist across restarts');
  } else {
    try {
      registry = await openRegistry(ctx, { scope: config.registryScope ?? 'user' });
    } catch (error) {
      logger.error(`tmux-xc: persistent registry unavailable; operations disabled: ${error?.message ?? error}`);
      registry = unavailableRegistry();
    }
  }

  // Cordis unload runs effect disposers, not an ordinary "dispose" event.
  // Register immediately after acquisition, including constructor/setup failures.
  let service;
  let stopHooks;
  let closing;
  ctx.effect(() => () => {
    closing ??= (async () => {
      await service?.close();
      await stopHooks?.();
      await registry.close();
    })();
    return closing;
  }, 'tmux-xc: service and registry');
  service = new TmuxXcService({ config, registry, logger });

  // Agent tools + approval policy (required).
  ctx.effect(() => registerTools(ctx, service, config), 'tmux-xc: tools');

  // Optional dependency: register on arrival, dispose on loss, re-register on
  // replacement. Use the injected context, not the outer plugin context.
  ctx.inject(['connection'], (connectionCtx) => {
    return registerRoutes(connectionCtx, service);
  });

  // workingDirectory is obtained lazily by tools at execution time.

  // Like dsh-session-reference, this is a context event, not an agents API;
  // registering it needs no agents service dependency.
  // The combined lifecycle disposer aborts service work before draining hooks;
  // a separate hook disposer could otherwise wait before cancellation begins.
  stopHooks = registerHooks(ctx, service, registry);
}
