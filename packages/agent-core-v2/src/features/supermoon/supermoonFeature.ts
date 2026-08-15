/**
 * `supermoon` domain — `SupermoonFeature`: the supermoon-mode capability
 * assembled as one App-scope Feature unit.
 *
 * Contributes the `EnterSupermoonMode` / `ExitSupermoonMode` agent tools
 * through the `features` base-class seams; retracting the unit withdraws them
 * across the scope tree. The `IAgentSupermoonService` stays on its static
 * import=register channel (`agent/supermoon/supermoonService`) — the service
 * predates the feature and keeps its existing static registration. Registered
 * into the feature table at import.
 */

import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { IEnterSupermoonModeTool } from './tools/enter-supermoon-mode/enter-supermoon-mode';
import { EnterSupermoonModeTool } from './tools/enter-supermoon-mode/enterSupermoonModeTool';
import { IExitSupermoonModeTool } from './tools/exit-supermoon-mode/exit-supermoon-mode';
import { ExitSupermoonModeTool } from './tools/exit-supermoon-mode/exitSupermoonModeTool';

export class SupermoonFeature extends Feature {
  static override readonly name = 'supermoon';

  constructor() {
    super();
    this.contributeTool(IEnterSupermoonModeTool, EnterSupermoonModeTool, {
      name: 'EnterSupermoonMode',
      domain: 'supermoon',
    });
    this.contributeTool(IExitSupermoonModeTool, ExitSupermoonModeTool, {
      name: 'ExitSupermoonMode',
      domain: 'supermoon',
    });
  }
}

registerFeature(SupermoonFeature);
