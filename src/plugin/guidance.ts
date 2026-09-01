/**
 * Standing guidance injected at session start (Hermes "Layer A" nudge, adapted
 * to coding agents). This is what makes the agent self-evolving WITHOUT the user
 * invoking anything: the agent is continuously aware it should crystallize and
 * improve skills as it works. The background hook (Layer B) is the safety net
 * that fires when the agent forgets.
 */
export const SKILLS_GUIDANCE = [
  'Skill Maxing is active: you can make yourself permanently better at this codebase.',
  '',
  'After you finish a non-trivial task — a multi-step workflow, a tricky fix, or a',
  'procedure you would repeat — crystallize it as a reusable skill:',
  '  skillmaxxing skillify --draft <draft.json>   # then review and: --commit <name>',
  '',
  'When you USE a skill and find it outdated, wrong, or missing a step, improve it',
  'immediately instead of working around it:',
  '  skillmaxxing optimize <action> ...           # eval-gated; promotes only on a strict win',
  '',
  'Rules of thumb:',
  '- Prefer UPDATING an existing skill over creating a near-duplicate (search first).',
  '- Scope it right (avoid skill pollution): default to PROJECT scope; add -g for',
  '  user/global ONLY when the skill transfers to ANY codebase. A skill about THIS',
  "  repo's build/layout/conventions stays project-local. When unsure, keep it local.",
  '- New and changed skills are recorded trusted:false until the user approves them.',
  '- Keep it conservative: one high-value skill beats five shallow ones.',
].join('\n');

/** Shorter reminder used by the Stop hook in nudge mode after substantive work. */
export const REFLECT_NUDGE = [
  'You just completed a substantial chunk of work. Before moving on, consider:',
  'is any of it a reusable workflow worth saving as a skill (skillmaxxing skillify),',
  'or did you use a skill that should be improved (skillmaxxing optimize)?',
  'Prefer updating an existing skill over creating a new one. Skip if nothing is reusable.',
].join(' ');
