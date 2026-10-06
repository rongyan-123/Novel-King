import fs from 'node:fs';

const root = new URL('./skills/', import.meta.url);
export const RESEARCH_SKILLS = Object.freeze(fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
  const text = fs.readFileSync(new URL(entry.name + '/SKILL.md', root), 'utf8');
  return { id: entry.name, name: text.match(/^description: ([^：:]+)[：:]/m)?.[1] || entry.name,
    description: text.match(/^description: (.+)$/m)?.[1] || '', text };
}));
export function getResearchSkill(id) {
  const skill = RESEARCH_SKILLS.find(candidate => candidate.id === id);
  if (!skill) throw Object.assign(new Error('没有找到这个研究技能'), { status: 400 });
  return skill;
}
