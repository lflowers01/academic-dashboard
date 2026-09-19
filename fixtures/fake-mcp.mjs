// A fake brightspace-mcp-server for integration tests (test-server.mjs). Behaviour comes from FAKE_MODE:
//   ok          normal data (dates relative to now)
//   auth        course list fails with a sign-in error
//   hang        course list never answers
//   courseauth  one course answers "unauthorized" (must NOT look like an expired login)
// Every call is appended to FAKE_LOG so tests can see what was asked.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

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
  tools: ['get_my_courses', 'get_assignments', 'get_my_grades', 'get_announcements', 'get_syllabus', 'get_course_content', 'download_file'].map(name => ({ name, inputSchema: { type: 'object' } })),
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
  // syllabus sources: MA 162's overview text has its midterm; CS 159 has a "Course Syllabus" file (HTML) with a project deadline and grading
  const long = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }); };
  if (name === 'get_syllabus') return text(args.courseId === 101
    ? { courseId: 101, description: { markdown: 'Welcome to MA 16200!' }, syllabusText: `Midterm Exam 2 is on ${long(20)} from 8:00-9:00 PM in ELLT 116.\nGrading: Quizzes 20%, Midterms 45%, Final Exam 35%.` }
    : { courseId: args.courseId, description: { markdown: '' }, syllabusText: '' });
  if (name === 'get_course_content') return text(args.courseId === 102
    ? { modules: [{ type: 'module', title: 'Start Here', children: [{ type: 'topic', topicType: 'file', title: 'Course Syllabus', topicId: 77 }, { type: 'topic', topicType: 'file', title: 'Lecture 1 slides', topicId: 78 }] }] }
    : { modules: [] });
  if (name === 'download_file') {
    if (args.topicId !== 77) return { ...text('not found'), isError: true };
    mkdirSync(args.downloadPath, { recursive: true });
    const filePath = join(args.downloadPath, 'Course Syllabus.html');
    writeFileSync(filePath, `<h1>CS 15900</h1><p>Project 2 is due ${long(12)} at 11:59 PM.</p><p>Projects 300 points, Exams 400 points, Labs 100 points.</p>`);
    return text({ success: true, filePath, mimeType: 'text/html' });
  }
  return { ...text('unknown tool'), isError: true };
});
await server.connect(new StdioServerTransport());
