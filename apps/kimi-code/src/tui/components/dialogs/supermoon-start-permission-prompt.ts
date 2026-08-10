import {
  StartPermissionPromptComponent,
  type StartPermissionOption,
} from './start-permission-prompt';

export type SupermoonStartPermissionChoice = 'auto' | 'yolo' | 'manual';

export interface SupermoonStartPermissionPromptOptions {
  readonly onSelect: (choice: SupermoonStartPermissionChoice) => void;
  readonly onCancel: () => void;
}

const OPTIONS: readonly StartPermissionOption<SupermoonStartPermissionChoice>[] = [
  {
    value: 'auto',
    label: 'Switch to Auto and start',
    description:
      'Best for supermoon tasks. Tools are approved automatically, and questions are skipped.',
  },
  {
    value: 'yolo',
    label: 'Switch to YOLO and start',
    description:
      'Tools and plan changes are approved automatically. Kimi Code may still ask you questions.',
  },
  {
    value: 'manual',
    label: 'Start in Manual',
    description:
      'Keep approvals on. Kimi Code may stop and wait for you during the supermoon task.',
  },
];

const NOTICE_LINES = [
  'Manual mode asks you before Kimi Code runs commands, edits files, or takes other risky actions.',
  'Manual mode can block supermoon work while agents are running.',
  'You can go back without losing your command.',
] as const;

export class SupermoonStartPermissionPromptComponent extends StartPermissionPromptComponent<SupermoonStartPermissionChoice> {
  constructor(opts: SupermoonStartPermissionPromptOptions) {
    super({
      title: 'Start a supermoon task with approvals on?',
      noticeLines: NOTICE_LINES,
      options: OPTIONS,
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
