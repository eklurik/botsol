import test from 'node:test';
import assert from 'node:assert/strict';
import { compareDecision, detectEscalation, evaluateRules, KNOWLEDGE_BASE, loadRegressionCases, runRegressionGate, sanitizeReply, shouldOfferManager } from './server.mjs';

test('finishes a ride in a service zone', () => {
  const answer = evaluateRules({ flags: ['active_ride', 'zone', 'zone_service'], intents: { finish: true }, snapshot: { zone: { verdict: 'service' }, ride: { amt: 0 } }, live: { activeRideCount: 1 } });
  assert.equal(answer.rule, 'R5');
  assert.equal(answer.action, 'finish_ride');
});

test('does not claim an allowed zone when zone state is unknown', () => {
  const answer = evaluateRules({ flags: ['active_ride'], intents: { finish: true }, snapshot: { ride: { amt: 0 } }, live: { activeRideCount: 1 } });
  assert.equal(answer, null);
});

test('does not auto-refund a money dispute', () => {
  const answer = evaluateRules({ flags: ['ride_paid', 'zone', 'zone_forbidden'], intents: { fineDispute: true }, snapshot: { zone: { verdict: 'black' }, ride: { amt: 80, }, }, live: { activeRideCount: 0 } });
  assert.equal(answer.rule, 'R14');
  assert.equal(answer.needsHuman, true);
  assert.equal(answer.risk, 'money');
});

test('routes unknown input to a safe fallback', () => {
  const answer = evaluateRules({ flags: [], intents: {}, snapshot: {}, live: { activeRideCount: 0 } });
  assert.equal(answer, null);
});

test('routes money requests to a manager before the model', () => {
  const escalation = detectEscalation('С меня списали деньги, хочу возврат');
  assert.equal(escalation.risk, 'money');
  assert.match(escalation.reply, /менеджер/i);
});

test('asks for financial details before offering manager handoff', () => {
  const input = { text: 'Хочу вернуть деньги, поездка не понравилась', conversation: [] };
  assert.equal(shouldOfferManager(input, detectEscalation(input.text)), false);
  input.conversation = [{ role: 'assistant', content: 'Напишите сумму и время поездки.' }];
  input.text = 'Списали 120 грн сегодня в 18:00, хочу менеджера';
  assert.equal(shouldOfferManager(input, detectEscalation(input.text)), true);
});

test('does not escalate informational payment questions', () => {
  assert.equal(detectEscalation('Как оплатить поездку?'), null);
  assert.equal(detectEscalation('Сколько стоит самокат?'), null);
});

test('routes aggression and safety concerns to a manager', () => {
  assert.equal(detectEscalation('Вы мошенники, буду обращаться в суд').risk, 'escalation');
  assert.equal(detectEscalation('Мне небезопасно, я получил травму').risk, 'safety');
});

test('loads service rules into the AI knowledge base', () => {
  assert.match(KNOWLEDGE_BASE, /R14/);
  assert.match(KNOWLEDGE_BASE, /завершить поездку/i);
  assert.match(KNOWLEDGE_BASE, /автоматическую верификацию/i);
  assert.match(KNOWLEDGE_BASE, /Bluetooth/i);
  assert.match(KNOWLEDGE_BASE, /support@bikenow.com.ua/i);
});

test('removes unsupported zone claims from AI replies', () => {
  const input = { flags: [], snapshot: { zone: {} } };
  assert.match(sanitizeReply('Вы находитесь в разрешённой зоне.', input), /не подтверждено/);
});

test('loads all 24 production discrepancies as regression cases', () => {
  const cases = loadRegressionCases();
  assert.equal(cases.length, 24);
  assert.equal(cases[0].id, 'DIFF-01');
  assert.equal(cases[0].expected.rule, 'R14');
  assert.equal(cases[0].input.signals.snapshot.zone.verdict, 'black');
});

test('regression gate compares rule and action, not only rule', () => {
  assert.equal(compareDecision({ rule: 'R14', action: 'escalate_refund' }, { rule: 'R14', action: 'escalate_refund' }), true);
  assert.equal(compareDecision({ rule: 'R14', action: 'escalate_operator' }, { rule: 'R14', action: 'escalate_refund' }), false);
  assert.equal(runRegressionGate().length, 24);
});
