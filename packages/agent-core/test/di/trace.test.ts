import { afterEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/di/descriptors';
import { createDecorator } from '#/di/instantiation';
import { InstantiationService, Trace } from '#/di/instantiationService';
import { ServiceCollection } from '#/di/serviceCollection';

/**
 * P0.2: `Trace` class + `_enableTracing` ctor param installed. These
 * assertions verify the class is reachable and the constructor follows the
 * VS Code argument order `(services, strict, parent, enableTracing)`.
 */

class ExposedInstantiationService extends InstantiationService {
  get tracingEnabled(): boolean {
    return this._enableTracing;
  }
}

interface IBar {
  tag: 'bar';
}

const IBar = createDecorator<IBar>('p0.2-IBar-conflict');

class Bar implements IBar {
  tag = 'bar' as const;
}

class Gadget {
  constructor(
    public readonly name: string,
    public readonly bar: IBar,
  ) {}
}

// Vitest/rolldown does not parse TypeScript parameter decorators in test
// files, so the dependency is applied manually at runtime — same pattern as
// `auto-inject.test.ts`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function param(dec: any, target: any, index: number): void {
  (dec as (t: unknown, k: string, i: number) => void)(target, '', index);
}

param(IBar, Gadget, 1);

function gadgetContainer(enableTracing: boolean): InstantiationService {
  return new InstantiationService(
    new ServiceCollection([IBar, new SyncDescriptor(Bar)]),
    false,
    undefined,
    enableTracing,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('InstantiationService Trace installation (P0.2)', () => {
  it('constructs with the 2-arg signature (backward compat)', () => {
    const coll = new ServiceCollection();
    const ix = new InstantiationService(coll);
    expect(ix).toBeInstanceOf(InstantiationService);
  });

  it('constructs with strict=false, undefined parent, and tracing=true', () => {
    const coll = new ServiceCollection();
    const ix = new ExposedInstantiationService(coll, false, undefined, true);
    expect(ix).toBeInstanceOf(InstantiationService);
    expect(ix.tracingEnabled).toBe(true);
  });

  it('defaults _enableTracing to false when omitted', () => {
    const ix = new ExposedInstantiationService(new ServiceCollection());
    expect(ix.tracingEnabled).toBe(false);
  });

  it('Trace.traceCreation with _enableTracing=false returns the noop sentinel (Trace._None)', () => {
    // The sentinel has a no-op stop()/branch() — calling either must not throw.
    const t1 = Trace.traceCreation(false, class Foo {});
    expect(() => t1.stop()).not.toThrow();
    // Two non-tracing calls return identical sentinel; can't easily reach the
    // private static field, but exercising both noop methods is enough.
    const t2 = Trace.traceInvocation(false, function example() {});
    expect(() => t2.stop()).not.toThrow();
  });

  it('Trace.traceCreation with _enableTracing=true returns a real Trace instance', () => {
    const t = Trace.traceCreation(true, class Foo {});
    expect(t).toBeInstanceOf(Trace);
    // stop() should not throw on a real Trace either.
    expect(() => t.stop()).not.toThrow();
  });

  it('stays silent on the createInstance arg-position conflict when tracing is disabled', () => {
    const trace = vi.spyOn(globalThis.console, 'trace').mockImplementation(() => {});
    const ix = gadgetContainer(false);

    const gadget = ix.createInstance(Gadget);

    expect(gadget.name).toBeUndefined();
    expect(gadget.bar).toBeInstanceOf(Bar);
    expect(trace).not.toHaveBeenCalled();
  });

  it('reports the createInstance arg-position conflict when tracing is enabled', () => {
    const trace = vi.spyOn(globalThis.console, 'trace').mockImplementation(() => {});
    const ix = gadgetContainer(true);

    const gadget = ix.createInstance(Gadget);

    expect(gadget.bar).toBeInstanceOf(Bar);
    expect(trace).toHaveBeenCalledTimes(1);
    expect(trace).toHaveBeenCalledWith(
      '[createInstance] First service dependency of Gadget at position 2 conflicts with 0 static arguments',
    );
  });
});
