import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateQuestion, validateQuiz, pairPlayers, comparePlayers } from '../backend/core.js';

const question = { question: '2 + 2?', answers: ['3', '4'], correctAnswerIndex: 1, timeLimit: 15 };

test('validates question bounds and normalizes options', () => {
  const result = validateQuestion(question);
  assert.deepEqual(result.errors, []);
  assert.equal(result.value.correctAnswerIndex, 1);
  assert.equal(validateQuestion({ ...question, answers: ['only one'] }).errors.length > 0, true);
});

test('quiz validation catches invalid question rows', () => {
  assert.equal(validateQuiz({ title: 'Quiz', questions: [question] }).errors.length, 0);
  assert.ok(validateQuiz({ title: '', questions: [] }).errors.length >= 2);
});

test('pairing covers even and odd rosters without duplicates', () => {
  const even = pairPlayers(['a', 'b', 'c', 'd'], () => 0.5);
  assert.equal(even.pairs.length, 2);
  assert.equal(new Set(even.pairs.flat()).size, 4);
  const odd = pairPlayers(['a', 'b', 'c'], () => 0.5);
  assert.equal(odd.pairs.length, 1);
  assert.equal(odd.byes.length, 1);
});

test('winner tie breakers favor accuracy then health then response time', () => {
  assert.equal(comparePlayers({ alive: true, correct: 2, hp: 5 }, { alive: true, correct: 1, hp: 90 }), 1);
  assert.equal(comparePlayers({ alive: true, correct: 2, hp: 80 }, { alive: true, correct: 2, hp: 60 }), 1);
  assert.equal(comparePlayers({ alive: true, correct: 2, hp: 80, responseTotal: 7000 }, { alive: true, correct: 2, hp: 80, responseTotal: 5000 }), 1);
});

test('demo quiz remains editable data with at least 30 valid questions', () => {
  const template=JSON.parse(fs.readFileSync(new URL('../db/seed-data.json',import.meta.url),'utf8'));
  assert.ok(template.questions.length>=30);
  assert.deepEqual(validateQuiz(template).errors,[]);
});
