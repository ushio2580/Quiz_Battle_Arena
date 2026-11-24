import { randomUUID } from 'node:crypto';

export const CHARACTERS = ['bot', 'ninja', 'explorer', 'knight', 'alien', 'warrior', 'mage', 'pixel'];

export function validateQuestion(input, index = 0) {
  const q = input ?? {};
  const question = String(q.question ?? '').trim();
  const answers = Array.isArray(q.answers) ? q.answers.map(a => String(a ?? '').trim()) : [];
  const errors = [];
  if (!question) errors.push(`Question ${index + 1}: question text is required.`);
  if (question.length > 2000) errors.push(`Question ${index + 1}: question text must be 2,000 characters or fewer.`);
  if (answers.length < 2 || answers.length > 4) errors.push(`Question ${index + 1}: provide 2 to 4 answers.`);
  if (answers.some(a => !a)) errors.push(`Question ${index + 1}: answer options cannot be blank.`);
  if (answers.some(a => a.length > 500)) errors.push(`Question ${index + 1}: answers must be 500 characters or fewer.`);
  const correct = Number(q.correctAnswerIndex ?? q.correctIndex);
  if (!Number.isInteger(correct) || correct < 0 || correct >= answers.length) errors.push(`Question ${index + 1}: choose a valid correct answer.`);
  const timeLimit = Number(q.timeLimit ?? 25);
  if (!Number.isInteger(timeLimit) || timeLimit < 5 || timeLimit > 180) errors.push(`Question ${index + 1}: time limit must be 5–180 seconds.`);
  const difficulty = ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium';
  const image = q.image == null || q.image === '' ? null : String(q.image);
  if (image && image.length > 1_000_000) errors.push(`Question ${index + 1}: image value must be under 1 MB.`);
  if (image && (!image.startsWith('https://') && !image.startsWith('data:image/'))) errors.push(`Question ${index + 1}: image must be an HTTPS URL or an image data URL.`);
  if (image?.startsWith('data:') && image.length > 1_000_000) errors.push(`Question ${index + 1}: embedded image must be under 1 MB.`);
  return { errors, value: {
    id: String(q.id ?? randomUUID()), question, answers, correctAnswerIndex: correct,
    explanation: String(q.explanation ?? '').slice(0, 2000), timeLimit,
    difficulty, wrongAnswerDamage: clamp(q.wrongAnswerDamage ?? q.wrongDamage, 0, 100, 25),
    correctAnswerReward: clamp(q.correctAnswerReward ?? q.correctReward, 0, 100, 10), image
  } };
}

function clamp(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}

export function validateQuiz(input) {
  const errors = [];
  const title = String(input?.title ?? '').trim();
  if (!title) errors.push('Quiz title is required.');
  if (title.length > 120) errors.push('Quiz title must be 120 characters or fewer.');
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  if (!questions.length) errors.push('Add at least one question.');
  if (questions.length > 500) errors.push('A quiz can contain at most 500 questions.');
  const normalized = questions.map((q, i) => {
    const result = validateQuestion(q, i);
    errors.push(...result.errors);
    return result.value;
  });
  return { errors, value: { title, description: String(input?.description ?? '').slice(0, 1000), questions: normalized } };
}

export function pairPlayers(ids, random = Math.random) {
  const pool = [...ids];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const byes = pool.length % 2 ? [pool.pop()] : [];
  const pairs = [];
  while (pool.length) pairs.push([pool.pop(), pool.pop()]);
  return { pairs, byes };
}

export function comparePlayers(a, b) {
  if (a.alive !== b.alive) return a.alive ? 1 : -1;
  if (a.correct !== b.correct) return Math.sign(a.correct - b.correct);
  if (a.hp !== b.hp) return Math.sign(a.hp - b.hp);
  const at = a.responseTotal || 0;
  const bt = b.responseTotal || 0;
  if (at !== bt) return Math.sign(bt - at);
  return 0;
}

export function publicQuestion(question, settings, number, total, zonePositions = {}) {
  return {
    id: question.id, question: question.question, answers: [...question.answers],
    number, total, image: question.image ?? null,
    readingSeconds: settings.readingSeconds, answerSeconds: question.timeLimit || settings.answerSeconds,
    zones: zonePositions
  };
}

