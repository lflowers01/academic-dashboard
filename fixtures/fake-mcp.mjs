// A fake brightspace-mcp-server for integration tests (test-server.mjs). Behaviour comes from FAKE_MODE:
//   ok          normal data (dates relative to now)
//   auth        course list fails with a sign-in error
//   hang        course list never answers
//   courseauth  one course answers "unauthorized" (must NOT look like an expired login)
// Every call is appended to FAKE_LOG so tests can see what was asked.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { appendFileSync } from 'node:fs';

const MODE = process.env.FAKE_MODE || 'ok';
const log = x => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, JSON.stringify(x) + '\n');
log({ pid: process.pid, mode: MODE });

const at = (days, h = 23, m = 59) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d.toISOString(); };
const courses = [
  { id: 101, name: 'Fall 2026 MA 16200', code: 'wl.202710.MA.16200.001', isActive: true, canAccess: true },
  { id: 102, name: 'Fall 2026 CS 15900', code: 'wl.202710.CS.15900.001', isActive: true, canAccess: true },
  { id: 103, name: 'Spring 2026 MA 16100', code: 'wl.202620.MA.16100.001', isActive: true, canAccess: true }, // past term: never fetched
  { id: 104, name: 'Old Club', code: 'old_club', isActive: false, canAccess: true },                         // inactive: never fetched
  { id: 105, name: 'Locked Site', code: 'locked', isActive: true, canAccess: false },                        // no access: never fetched
];
const assignments = {
  101: [
    { type: 'assignment', id: 1, name: 'HW 3', dueDate: at(0, 23, 59), submission: null, points: 10, instructions: { markdown: '' }, url: 'https://x/1' },
    { type: 'quiz', id: 2, name: 'Exam 2', dueDate: at(9, 20, 0), startDate: at(9, 19, 0), timeLimit: 60, instructions: { markdown: '' } },
    { type: 'quiz', id: 3, name: 'Exam 2 Practice Quiz', dueDate: at(8), instructions: { markdown: '' } },
  ],
  102: [
    { type: 'assignment', id: 4, name: 'Lab 5', dueDate: at(1, 8, 30), submission: null, instructions: { markdown: '' } },
    { type: 'assignment', id: 5, name: 'Lab 4', dueDate: at(-1), submission: { files: [] }, instructions: { markdown: '' } },
    { type: 'assignment', id: 6, name: 'Project', dueDate: at(1, 23, 59), submission: null, instructions: { markdown: '' } },
  ],
};
const d3 = new Date(); d3.setDate(d3.getDate() + 3);
const announcements = [
  { id: 900, courseId: 101, title: 'Exam 1 Information', body: `The first exam is on ${d3.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} from 8:00-9:00PM.`, date: new Date().toISOString() },
];

const text = v => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] });
const server = new Server({ name: 'fake-brightspace', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ['get_my_courses', 'get_assignments', 'get_my_grades', 'get_announcements'].map(name => ({ name, inputSchema: { type: 'object' } })),
}));
server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args = {} } = req.params;
  log({ name, args });
  if (name === 'get_my_courses') {
    if (MODE === 'auth') return { ...text('Brightspace sign-in required. Run: npx -y brightspace-mcp-server@latest auth'), isError: true };
    if (MODE === 'hang') return new Promise(() => {});
    return text(courses);
  }
  if (name === 'get_assignments') {
    if (MODE === 'courseauth' && args.courseId === 102) return { ...text('Unauthorized: 403 for this org unit'), isError: true };
    return text({ courseId: args.courseId, assignments: assignments[args.courseId] || [] });
  }
  if (name === 'get_my_grades') return text({ courseId: args.courseId, grades: [] });
  if (name === 'get_announcements') return text(announcements);
  return { ...text('unknown tool'), isError: true };
});
await server.connect(new StdioServerTransport());
