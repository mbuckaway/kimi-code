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
