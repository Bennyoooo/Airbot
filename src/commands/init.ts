import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectInstalledAgents } from '../agents/registry.js';
import { ensureDir } from '../util/fs.js';
import * as log from '../util/log.js';

const TEMPLATE = `---
name: my-skill
description: A brief description of what this skill does
version: 1.0.0
tools:
  - Bash
  - Read
triggers:
  - activate this skill
---

# my-skill

Instructions for the agent go here.

## When to use

Describe when this skill should be activated.

## Steps

1. First step
2. Second step
3. Third step
`;

export interface InitArgs {
  name?: string;
  dir?: string;
}

export async function init(args: InitArgs): Promise<void> {
  const dir = args.dir ?? process.cwd();
  const name = args.name ?? 'my-skill';

  const agents = await detectInstalledAgents();
  log.heading('skillmaxxing init');
  log.info(`Detected agents: ${agents.length > 0 ? agents.map(a => a.displayName).join(', ') : 'none'}`);

  const skillDir = path.join(dir, name);
  if (fs.existsSync(skillDir)) {
    log.warn(`Directory already exists: ${skillDir}`);
    return;
  }

  ensureDir(skillDir);
  const skillMd = TEMPLATE.replace(/my-skill/g, name);
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd);

  log.success(`Created ${skillDir}/SKILL.md`);
  log.info(`Edit the SKILL.md, then run: skillmaxxing install ./${name}`);
}
