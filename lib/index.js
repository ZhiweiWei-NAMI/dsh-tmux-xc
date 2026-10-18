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
import { openRegistry, memoryRegistry } from './registry.js';

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
const SOCKET_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

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
                id: z.string().pattern(SOCKET_KEY_PATTERN).required().description('socket key'),
                name: z.string().pattern(SOCKET_KEY_PATTERN).description('tmux -L name'),
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
        }),
      ]),
    )
    .default([]),
  sshPath: z.string().default('').description('path to ssh binary ("" resolves ssh on PATH)'),
  sshConfigFile: z.string().default('').description('optional -F config file (tests only)'),
  connectTimeoutSec: z.number().step(1).min(1).default(10),
  commandTimeoutMs: z.number().step(1).min(1).default(20000),
  registryScope: z.union(['user', 'profile']).default('user'),
  approval: z
    .object({
      create: z.union(['ask', 'allow']).default('ask'),
      send: z.union(['ask', 'allow']).default('ask'),
      detach: z.union(['ask', 'allow']).default('ask'),
    })
    .default({}),
  capture: z
    .object({
      defaultLines: z.number().step(1).min(1).default(80),
      maxLines: z.number().step(1).min(1).default(2000),
      maxBytes: z.number().step(1).min(1).default(65536),
    })
    .default({}),
});

export async function apply(ctx, config) {
  const logger = ctx.logger('tmux-xc');

  // Registry: durable when the storage domain is available, otherwise in-memory.
  let registry;
  try {
    registry = await openRegistry(ctx, { scope: config.registryScope ?? 'user' });
  } catch (error) {
    registry = memoryRegistry();
    logger.warn(`tmux-xc: storage domain unavailable (${error?.message ?? error}); registry will not persist across restarts`);
  }

  const service = new TmuxXcService({ config, registry, logger });

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
  ctx.effect(() => registerHooks(ctx, service, registry), 'tmux-xc: hooks');

  // Abort in-flight remote work and close the registry on unload.
  ctx.on('dispose', async () => {
    service.close();
    await registry.close();
  });
}
