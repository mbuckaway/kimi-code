import { describe, expect, it } from 'vitest';

import { AgentFileParseError, parseAgentFileText } from '#/workspace/workspaceAgentProfileLoader/internal/agentFile';
import { agentProfileFromFile } from '#/workspace/workspaceAgentProfileLoader/internal/agentProfileFromFile';
import type { AgentFileDefinition } from '#/workspace/workspaceAgentProfileLoader/internal/types';
import type {
  AgentProfileContext,
  SystemPromptRenderResult,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { renderSystemPromptResult } from '#/app/agentProfileCatalog/profile-shared';

const FULL_FILE = `---
name: code-reviewer
description: 严格的代码审查 agent
whenToUse: 代码评审、PR 检查
override: true
tools:
  - Read
  - Grep
  - mcp__github__*
disallowedTools:
  - Bash
subagents:
  - explore
  - plan
unknownField: tolerated
---

你是严格的代码审查者。
`;

function parse(text: string): AgentFileDefinition {
  return parseAgentFileText({ path: '/tmp/agents/reviewer.md', source: 'project', text });
}

describe('parseAgentFileText', () => {
  it('parses a full agent file', () => {
    const def = parse(FULL_FILE);

    expect(def.name).toBe('code-reviewer');
    expect(def.description).toBe('严格的代码审查 agent');
    expect(def.whenToUse).toBe('代码评审、PR 检查');
    expect(def.override).toBe(true);
    expect(def.tools).toEqual(['Read', 'Grep', 'mcp__github__*']);
    expect(def.disallowedTools).toEqual(['Bash']);
    expect(def.subagents).toEqual(['explore', 'plan']);
    expect(def.prompt).toBe('你是严格的代码审查者。');
    expect(def.source).toBe('project');
  });

  it('leaves optional fields undefined when omitted', () => {
    const def = parse('---\nname: solo\ndescription: d\n---\n\nbody\n');

    expect(def.override).toBe(false);
    expect(def.tools).toBeUndefined();
    expect(def.disallowedTools).toBeUndefined();
    expect(def.subagents).toBeUndefined();
    expect(def.whenToUse).toBeUndefined();
    expect(def.prompt).toBe('body');
  });

  it('rejects missing frontmatter', () => {
    expect(() => parse('no frontmatter here')).toThrow(AgentFileParseError);
  });

  it('rejects non-mapping frontmatter', () => {
    expect(() => parse('---\n- just\n- a\n- list\n---\n\nbody\n')).toThrow(/mapping/);
  });

  it('rejects invalid yaml frontmatter', () => {
    expect(() => parse('---\nfoo: [unclosed\n---\n\nbody\n')).toThrow(AgentFileParseError);
  });

  it('derives the name from the file name when omitted', () => {
    const def = parse('---\ndescription: d\n---\n\nbody\n');

    expect(def.name).toBe('reviewer');
  });

  it('rejects when the name is neither provided nor derivable', () => {
    expect(() =>
      parseAgentFileText({
        path: '/tmp/agents/.md',
        source: 'project',
        text: '---\ndescription: d\n---\n\nbody\n',
      }),
    ).toThrow(/"name"/);
  });

  it('rejects a derived name that is not kebab-case', () => {
    expect(() =>
      parseAgentFileText({
        path: '/tmp/agents/My Agent.md',
        source: 'project',
        text: '---\ndescription: d\n---\n\nbody\n',
      }),
    ).toThrow(/kebab-case/);
  });

  it('rejects a missing description', () => {
    expect(() => parse('---\nname: solo\n---\n\nbody\n')).toThrow(/"description"/);
  });

  it('rejects non kebab-case names', () => {
    expect(() => parse('---\nname: CodeReviewer\ndescription: d\n---\n\nbody\n')).toThrow(
      /kebab-case/,
    );
    expect(() => parse('---\nname: code_reviewer\ndescription: d\n---\n\nbody\n')).toThrow(
      /kebab-case/,
    );
  });

  it('ignores a foreign mode field (e.g. OpenCode "mode: subagent")', () => {
    const def = parse('---\nname: solo\ndescription: d\nmode: subagent\n---\n\nbody\n');

    expect(def.name).toBe('solo');
    expect(def.prompt).toBe('body');
    expect(def.mode).toBe('overlay');
  });

  it('rejects a non-boolean override field', () => {
    expect(() => parse('---\nname: solo\ndescription: d\noverride: yes\n---\n\nbody\n')).toThrow(
      /"override"/,
    );
  });

  it('accepts a comma-separated tools string (Claude Code style)', () => {
    const def = parse(
      '---\nname: solo\ndescription: d\ntools: Read, Grep,mcp__github__*\ndisallowedTools: Bash\n---\n\nbody\n',
    );

    expect(def.tools).toEqual(['Read', 'Grep', 'mcp__github__*']);
    expect(def.disallowedTools).toEqual(['Bash']);
  });

  it('treats a lone "*" tools field as all tools', () => {
    const fromString = parse('---\nname: solo\ndescription: d\ntools: "*"\n---\n\nbody\n');
    const fromList = parse('---\nname: solo\ndescription: d\ntools:\n  - "*"\n---\n\nbody\n');

    expect(fromString.tools).toBeUndefined();
    expect(fromList.tools).toBeUndefined();
  });

  it('accepts a comma-separated subagents string', () => {
    const def = parse('---\nname: solo\ndescription: d\nsubagents: explore, plan\n---\n\nbody\n');

    expect(def.subagents).toEqual(['explore', 'plan']);
  });

  it('treats a lone "*" subagents field as all subagent types', () => {
    const def = parse('---\nname: solo\ndescription: d\nsubagents: "*"\n---\n\nbody\n');

    expect(def.subagents).toEqual(['*']);
  });

  it('rejects a non-string, non-list subagents field', () => {
    expect(() => parse('---\nname: solo\ndescription: d\nsubagents: 42\n---\n\nbody\n')).toThrow(
      /"subagents"/,
    );
  });

  it('rejects a non-string, non-list tools field', () => {
    expect(() => parse('---\nname: solo\ndescription: d\ntools: 42\n---\n\nbody\n')).toThrow(
      /"tools"/,
    );
  });

  it('rejects non-string tool entries', () => {
    expect(() =>
      parse('---\nname: solo\ndescription: d\ntools:\n  - 42\n---\n\nbody\n'),
    ).toThrow(/non-empty strings/);
  });

  it('rejects an empty prompt body', () => {
    expect(() => parse('---\nname: solo\ndescription: d\n---\n')).toThrow(/prompt body/);
  });

  it('parses a persona mode, base, and skills', () => {
    const def = parse(
      '---\nname: reviewer\ndescription: d\nmode: replace\nextends: coder\nskills:\n  - api-design\n  - testing\n---\n\nbody\n',
    );

    expect(def.mode).toBe('replace');
    expect(def.extends).toBe('coder');
    expect(def.skills).toEqual(['api-design', 'testing']);
  });

  it('defaults mode to overlay', () => {
    expect(parse('---\nname: solo\ndescription: d\n---\n\nbody\n').mode).toBe('overlay');
  });

  it('accepts a comma-separated skills string', () => {
    const def = parse('---\nname: solo\ndescription: d\nskills: api-design, testing\n---\n\nbody\n');

    expect(def.skills).toEqual(['api-design', 'testing']);
  });

  it('accepts expertise as a skills alias', () => {
    const def = parse(
      '---\nname: solo\ndescription: d\nexpertise: api-design, testing\n---\n\nbody\n',
    );

    expect(def.skills).toEqual(['api-design', 'testing']);
  });

  it('prefers skills over the expertise alias', () => {
    const def = parse(
      '---\nname: solo\ndescription: d\nskills: api-design\nexpertise: testing\n---\n\nbody\n',
    );

    expect(def.skills).toEqual(['api-design']);
  });

  it('rejects a non-string extends field', () => {
    const act = () => parse('---\nname: solo\ndescription: d\nextends: 42\n---\n\nbody\n');

    expect(act).toThrow(AgentFileParseError);
    expect(act).toThrow(/"extends"/);
  });

  it('treats an empty extends field as absent', () => {
    const def = parse('---\nname: solo\ndescription: d\nextends: ""\n---\n\nbody\n');

    expect(def.extends).toBeUndefined();
  });

  it('rejects a persona file without extends when requireExtends is set', () => {
    let failure: unknown;
    try {
      parseAgentFileText({
        path: '/tmp/agents/reviewer.md',
        source: 'explicit',
        text: '---\nname: reviewer\ndescription: d\n---\n\nbody\n',
        requireExtends: true,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AgentFileParseError);
    expect((failure as Error).message).toContain('extends');
    expect((failure as Error).message).toContain('persona.base_required');
  });

  it('accepts a persona file with extends when requireExtends is set', () => {
    const def = parseAgentFileText({
      path: '/tmp/agents/reviewer.md',
      source: 'explicit',
      text: '---\nname: reviewer\ndescription: d\nextends: coder\n---\n\nbody\n',
      requireExtends: true,
    });

    expect(def.extends).toBe('coder');
  });

  it('types extends as a required string when requireExtends is set', () => {
    const def = parseAgentFileText({
      path: '/tmp/agents/reviewer.md',
      source: 'explicit',
      text: '---\nname: reviewer\ndescription: d\nextends: coder\n---\n\nbody\n',
      requireExtends: true,
    });
    const declaredBase: string = def.extends;

    expect(declaredBase).toBe('coder');
  });
});

describe('agentProfileFromFile', () => {
  const base: AgentFileDefinition = {
    name: 'reviewer',
    description: 'd',
    whenToUse: 'reviews',
    override: false,
    mode: 'overlay',
    prompt: 'PROMPT_BODY',
    path: '/tmp/agents/reviewer.md',
    source: 'user',
  };
  const basePrompt = (): SystemPromptRenderResult => ({
    text: 'BASE_PROMPT',
    environment: { cwd: '' },
  });

  it('returns a plain body verbatim and injects no unreferenced context', () => {
    const profile = agentProfileFromFile(base, basePrompt);
    const prompt = profile.systemPrompt({
      agentsMd: 'AGENTS_MD_CONTENT',
      skills: 'SKILLS_LISTING',
      pluginSections: 'PLUGIN_INSTRUCTIONS',
    });

    expect(prompt).toBe('PROMPT_BODY');
    expect(profile.tools).toBeUndefined();
    expect(profile.whenToUse).toBe('reviews');
    expect(profile.override).toBe(false);
  });

  it('substitutes context variables in the body', () => {
    const profile = agentProfileFromFile(
      { ...base, prompt: 'cwd=${cwd} agents=${agents_md} skills=${skills}' },
      basePrompt,
    );
    const prompt = profile.systemPrompt({
      cwd: '/work',
      agentsMd: 'AGENTS_MD_CONTENT',
      skills: 'SKILLS_LISTING',
    });

    expect(prompt).toBe('cwd=/work agents=AGENTS_MD_CONTENT skills=SKILLS_LISTING');
  });

  it('empties ${skills} when the file allowlist drops the Skill tool', () => {
    const profile = agentProfileFromFile(
      { ...base, prompt: 'skills=${skills}', tools: ['Read'] },
      basePrompt,
    );

    expect(profile.systemPrompt({ skills: 'SKILLS_LISTING' })).toBe('skills=');
  });

  it('empties ${skills} when Skill is in disallowedTools', () => {
    const profile = agentProfileFromFile(
      { ...base, prompt: 'skills=${skills}', disallowedTools: ['Skill'] },
      basePrompt,
    );

    expect(profile.systemPrompt({ skills: 'SKILLS_LISTING' })).toBe('skills=');
  });

  it('embeds the effective default prompt via ${base_prompt}', () => {
    const profile = agentProfileFromFile(
      { ...base, prompt: 'extra instructions\n\n${base_prompt}' },
      basePrompt,
    );

    expect(profile.systemPrompt({})).toBe('extra instructions\n\nBASE_PROMPT');
  });

  it('forwards the base prompt environment disclosure through renderSystemPrompt', () => {
    const profile = agentProfileFromFile(
      { ...base, prompt: 'extra instructions\n\n${base_prompt}' },
      (): SystemPromptRenderResult => ({
        text: 'BASE_PROMPT',
        environment: { cwd: '/work' },
      }),
    );

    const rendered = profile.renderSystemPrompt({ cwd: '/work' });
    expect(rendered.text).toBe('extra instructions\n\nBASE_PROMPT');
    expect(rendered.environment).toEqual({ cwd: '/work' });
  });

  it('places plugin instructions where ${plugin_sections} is referenced', () => {
    const profile = agentProfileFromFile(
      { ...base, prompt: 'before\n${plugin_sections}after' },
      basePrompt,
    );

    const prompt = profile.systemPrompt({ pluginSections: 'PLUGIN_INSTRUCTIONS' });

    expect(prompt).toContain('before');
    expect(prompt).toContain('# Plugin Instructions');
    expect(prompt).toContain('PLUGIN_INSTRUCTIONS');
    expect(prompt).toContain('after');
  });

  it('passes tools and disallowedTools through', () => {
    const profile = agentProfileFromFile(
      { ...base, tools: ['Read'], disallowedTools: ['Bash'] },
      basePrompt,
    );

    expect(profile.tools).toEqual(['Read']);
    expect(profile.disallowedTools).toEqual(['Bash']);
  });

  it('passes subagents through', () => {
    const profile = agentProfileFromFile({ ...base, subagents: ['explore'] }, basePrompt);

    expect(profile.subagents).toEqual(['explore']);
  });

  it('treats an explicit file as an override intent', () => {
    const profile = agentProfileFromFile({ ...base, source: 'explicit' }, basePrompt);

    expect(profile.override).toBe(true);
  });

  it('ignores persona fields without extends', () => {
    const profile = agentProfileFromFile({ ...base, mode: 'replace' }, basePrompt);

    expect(profile.mode).toBeUndefined();
    expect(profile.extends).toBeUndefined();
    expect(profile.persona).toBeUndefined();
    expect(profile.systemPrompt({})).toBe('PROMPT_BODY');
  });
});

describe('agentProfileFromFile personas', () => {
  const base: AgentFileDefinition = {
    name: 'reviewer',
    description: 'd',
    override: false,
    mode: 'overlay',
    extends: 'agent',
    prompt: 'PERSONA_ROLE',
    skills: ['api-design'],
    path: '/tmp/agents/reviewer.md',
    source: 'user',
  };
  const basePrompt = (): SystemPromptRenderResult => ({
    text: 'BASE_PROMPT',
    environment: { cwd: '' },
  });
  const renderedBasePrompt = (context: AgentProfileContext): SystemPromptRenderResult =>
    renderSystemPromptResult('', context, { skillActive: true });

  it('renders the persona block at the role slot in overlay mode', () => {
    const profile = agentProfileFromFile(base, renderedBasePrompt);

    const prompt = profile.systemPrompt({});

    expect(prompt).toContain('\n\nPERSONA_ROLE\n\n');
    expect(prompt).toContain('You are strongest at: api-design.');
  });

  it('exposes the persona fields on the profile in overlay mode', () => {
    const profile = agentProfileFromFile(base, renderedBasePrompt);

    expect(profile.mode).toBe('overlay');
    expect(profile.extends).toBe('agent');
    expect(profile.persona).toBe('PERSONA_ROLE');
    expect(profile.skills).toEqual(['api-design']);
  });

  it('renders the persona body and skills guidance in replace mode', () => {
    const profile = agentProfileFromFile(
      { ...base, mode: 'replace', prompt: 'PERSONA_ROLE' },
      basePrompt,
    );

    expect(profile.systemPrompt({})).toBe(
      'PERSONA_ROLE\n\nYou are strongest at: api-design.',
    );
  });

  it('keeps ${base_prompt} working in replace mode', () => {
    const profile = agentProfileFromFile(
      { ...base, mode: 'replace', prompt: 'PERSONA_ROLE\n\n${base_prompt}', skills: [] },
      basePrompt,
    );

    expect(profile.systemPrompt({})).toBe('PERSONA_ROLE\n\nBASE_PROMPT');
  });

  it('empties ${skills} in replace mode when the file allowlist drops the Skill tool', () => {
    const profile = agentProfileFromFile(
      { ...base, mode: 'replace', prompt: 'skills=${skills}', tools: ['Read'], skills: [] },
      basePrompt,
    );

    expect(profile.systemPrompt({ skills: 'SKILLS_LISTING' })).toBe('skills=');
  });

  it('forwards the base prompt environment disclosure in overlay mode', () => {
    const profile = agentProfileFromFile(
      base,
      (context): SystemPromptRenderResult => ({
        text: 'BASE_PROMPT',
        environment: { cwd: context.cwd ?? '' },
      }),
    );

    expect(profile.renderSystemPrompt({ cwd: '/work' }).environment).toEqual({ cwd: '/work' });
  });
});
