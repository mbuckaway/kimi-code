import type { ServerResponse } from 'node:http';

import { z } from 'zod';

import { okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';

interface ShutdownRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export interface ShutdownRouteOptions {
  readonly onShutdown: () => void;
}

export function registerShutdownRoutes(
  app: ShutdownRouteHost,
  opts: ShutdownRouteOptions,
): void {
  const route = defineRoute(
    {
      method: 'POST',
      path: '/shutdown',
      success: { data: z.object({ ok: z.literal(true) }) },
      description: 'Gracefully shut down the server',
      tags: ['meta'],
    },
    (req, reply) => {
      requestLog(req)?.info(
        { remoteAddress: (req as unknown as { ip?: string }).ip },
        'shutdown requested',
      );
      const { raw } = reply as unknown as { raw: ServerResponse };
      let shutdownBegun = false;
      const beginShutdownOnceReplyIsGone = (): void => {
        if (shutdownBegun) return;
        shutdownBegun = true;
        raw.off('finish', beginShutdownOnceReplyIsGone);
        raw.off('close', beginShutdownOnceReplyIsGone);
        opts.onShutdown();
      };
      raw.once('finish', beginShutdownOnceReplyIsGone);
      raw.once('close', beginShutdownOnceReplyIsGone);
      reply.send(okEnvelope({ ok: true }, req.id));
    },
  );
  app.post(
    route.path,
    route.options,
    route.handler as Parameters<ShutdownRouteHost['post']>[2],
  );
}
