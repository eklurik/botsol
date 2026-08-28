import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');

for (const directory of [ROOT, PUBLIC]) {
  for (const filename of readdirSync(directory)) {
    if (!/^\.env\s*$/.test(filename)) continue;
    try {
      const envFile = readFileSync(join(directory, filename), 'utf8');
      for (const line of envFile.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
        if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
      }
    } catch {
      // An unreadable local env file does not block the rule engine.
    }
  }
}

export const PORT = Number(process.env.PORT || 8787);

function loadKnowledgeBase() {
  return `
--- BikeNow: выжимка из правил и FAQ ---
Сервис: BikeNow предоставляет прокат велосипедов и электросамокатов; доступность транспорта и актуальные тарифы проверяются в мобильном приложении.
Регистрация: официальные условия указывают автоматическую верификацию; пользователь указывает свои настоящие имя, фамилию, адрес, e-mail, номер телефона и данные своей платёжной карты. Нельзя использовать чужую карту или чужие данные.
Старт: скачать приложение, зарегистрироваться и привязать карту; открыть карту, выбрать транспорт, включить Bluetooth, нажать «Сканирование» и просканировать QR-код замка. Для велосипеда также доступен ввод ID замка вручную.
Разблокировка: дождаться прогресс-бара и сигнала замка; если замок держит спица, аккуратно потянуть ручку вверх. При проблеме проверить Bluetooth, интернет и актуальность приложения; не повторять запрос много раз.
Завершение: проверить в приложении сервисную зону и зону запретного паркинга, припарковать транспорт так, чтобы он не мешал людям и машинам, закрыть замок, дождаться сигнала замка и проверить завершение в приложении. После завершения сделать фото транспорта в приложении.
Пауза: нажать «Пауза» в приложении, дождаться подтверждения режима и только после этого закрыть замок; время паузы тарифицируется по выбранному тарифу.
Неисправность: проверить безопасность транспорта до поездки; при дефекте прекратить использование, сообщить BikeNow и завершить поездку. Не утверждать наличие технической проблемы без сообщения клиента или сигналов.
Возраст и безопасность: условия указывают минимальный возраст 18 лет; соблюдать ПДД, использовать защитное снаряжение и не перевозить пассажиров.
Города: условия указывают Киев, Львов, Бровары, Бучу, Вишнёвое и Украинку; фактический список доступных зон нужно смотреть в приложении.
R5: завершение поездки допустимо только при activeRide и явно подтверждённой зоне service/allowed.
R14/R2/R7: спор о списании, возврат, штраф, доплата или вывод денег не решать автоматически; собрать детали и передать менеджеру.
R3/R4/R8: отсутствие движения, ошибка замка или подтверждённая поломка требуют проверки и безопасных инструкций.
RN2: активная поездка в запрещённой зоне требует вернуть транспорт в разрешённую зону; не утверждать состояние без signals.
Безопасность: при травме или непосредственной опасности сначала обратиться в экстренные службы, затем передать менеджеру.
Поддержка: официальный сайт указывает support@bikenow.com.ua, Telegram-бот BikeNowHelp_bot и номер 800210441.
Оффтопик: кратко ответить на безопасный вопрос и мягко вернуть разговор к BikeNow.
`.trim();
}

export const KNOWLEDGE_BASE = loadKnowledgeBase();

export function loadRegressionCases() {
  const fixture = JSON.parse(readFileSync(join(ROOT, '04_Расхождения_24_случая.json'), 'utf8'));
  return fixture.cases.map((caseData) => ({
    id: caseData.case_id,
    text: caseData.client_text,
    input: {
      text: caseData.client_text,
      signals: caseData.input_signals,
      conversation: []
    },
    expected: caseData.prod_decision,
    previous: caseData.new_version_decision
  }));
}

export function compareDecision(actual, expected) {
  return actual?.rule === expected?.rule && actual?.action === expected?.action;
}

export function runRegressionGate(evaluator = evaluateRules) {
  return loadRegressionCases().map((caseData) => {
    const actual = evaluator(caseData.input);
    return {
      id: caseData.id,
      expected: caseData.expected,
      actual: actual ? { rule: actual.rule, action: actual.action } : null,
      match: compareDecision(actual, caseData.expected),
      input: caseData.input
    };
  });
}

export function sanitizeReply(reply, input) {
  const zoneVerdict = input.snapshot?.zone?.verdict;
  const zoneKnown = ['service', 'allowed', 'paid', 'black', 'red'].includes(zoneVerdict)
    || input.flags.includes('zone_service')
    || input.flags.includes('zone_forbidden')
    || input.flags.includes('zone_paid');
  if (zoneKnown) return reply;
  return reply
    .replace(/вы находитесь в разрешённой зоне/gi, 'состояние зоны пока не подтверждено')
    .replace(/вы находитесь в разрешенной зоне/gi, 'состояние зоны пока не подтверждено')
    .replace(/не находится в запрещённой зоне/gi, 'состояние зоны пока не подтверждено')
    .replace(/не находится в запрещенной зоне/gi, 'состояние зоны пока не подтверждено')
    .replace(/зона разрешена/gi, 'состояние зоны пока не подтверждено');
}

const has = (flags, value) => flags.includes(value);

function inferInput(text) {
  const value = text.toLowerCase();
  const flags = [];
  const intents = {};
  if (/верни|вернуть|возврат|деньги|гроші|списал|списали|штраф|начисл|плат[её]ж|кошти/.test(value)) intents.fineDispute = true;
  if (/заверш|закры|закінч|припин/.test(value)) intents.finish = true;
  if (/слом|не едет|не їхав|не їде|не працю|не работает|злам|разряд|глох|сигнализац|сигналіз|перестал їхати|перестал ехать/.test(value)) intents.broken = true;
  if (/застр|заборон|червон|чёрн|не могу вернуться|не можу повернутися/.test(value)) intents.zoneEngaged = true;
  if (/тривог|тревог|сирен|air.?raid/.test(value)) flags.push('incident');
  if (/на карту|на картку|вывести|вивести|верни.*деньг|верните деньги|поверніть гроші/.test(value)) intents.balanceOut = true;
  if (/не разблок|не розблок|замок не|не відкрив/.test(value)) { flags.push('unlock_failed'); intents.startFail = true; }
  if (/не едет|не їде|слом|злам|разряд|глох/.test(value)) flags.push('iot_err');
  if (/штраф|списал|списали|начисл|доплат|деньги|деньг|гроші|кошти|возврат|верни|вернуть/.test(value)) flags.push('ride_paid');
  if (/червон|чёрн|заборон|не можу повернутися|не могу вернуться/.test(value)) flags.push('zone_forbidden');
  if (/платн|парковоч|100 грн|100 грив/.test(value)) flags.push('zone_paid');
  return { flags, intents, snapshot: { zone: {}, ride: { amt: 0 } }, live: { activeRideCount: 0 }, history: {} };
}

export function detectEscalation(text = '') {
  const value = String(text).toLowerCase();
  if (/убь|убью|умереть|самоуб|пореж|травм|угроз|застрел|суицид|небезопасн|небезпечно/.test(value)) {
    return { risk: 'safety', reason: 'Упоминание угрозы, травмы или риска для жизни.', reply: 'Мне жаль, что вы столкнулись с такой ситуацией. Пожалуйста, сначала отойдите в безопасное место и при непосредственной опасности позвоните в экстренные службы. Я немедленно передам обращение менеджеру.' };
  }
  if (/идиот|дебил|ненавиж|мошенн|вор|обман|жалоб[ау]|суд|прокуратур|убирай|бесит|достал|урод|нахуй|бляд|сука|fuck|damn/.test(value)) {
    return { risk: 'escalation', reason: 'Конфликтный, агрессивный или юридически чувствительный запрос.', reply: 'Понимаю, что ситуация вас сильно разозлила. Я зафиксировал обращение и передам его менеджеру, чтобы он лично разобрался и ответил в этом чате.' };
  }
  if (/деньг|гроші|кошти|списал|списан|плат[её]ж|штраф|возврат|верни|вернуть|верните|компенсац|перерасч[её]т|доплат|номер карты|номер картки|cvv|код из sms/.test(value)) {
    return { risk: 'money', reason: 'Финансовый вопрос без достаточных данных для автоматического решения.', reply: 'Понимаю, что вопрос касается денег. Чтобы менеджер быстро проверил операцию, напишите сумму, дату или время поездки и что именно произошло. Я передам обращение на ручную проверку и не буду обещать возврат до сверки данных.' };
  }
  return null;
}

export function shouldOfferManager(input, escalation, rule = null) {
  if (!escalation && !rule?.managerAction) return false;
  if (escalation?.risk === 'safety') return true;
  const text = input.text.toLowerCase();
  if (/менеджер|оператор|живой человек|человека|передайте|передати|підключіть менеджера/.test(text)) return true;
  const hasCaseDetails = /\d+(?:[.,]\d+)?\s*(грн|₴|руб|рубл|дол|usd|uah)|сегодня|вчера|сейчас|сьогодні|вчора|час|хвилин|поездк|поїзд/.test(text);
  const hasPriorClarification = input.conversation.some((message) => /сумм|дат|время|поездк|детал|подроб|ситуац|сума|час|поїзд/i.test(String(message.content || '')));
  return hasCaseDetails && hasPriorClarification;
}

export function normalizeInput(body = {}) {
  const source = body.input || body;
  const signals = source.signals || {};
  const snapshot = signals.snapshot || source.snapshot || {};
  const flags = signals.flags || source.flags || [];
  const text = String(source.client_text || source.text || '').trim();
  const inferred = inferInput(text);
  const activeRide = Number(snapshot.activeRideCount ?? source.live?.activeRideCount ?? 0) === 1 || flags.includes('active_ride');
  return {
    text,
    flags: [...new Set([...flags, ...inferred.flags.filter((flag) => (flag !== 'incident' || activeRide) && (flag !== 'zone_forbidden' || !flags.includes('zone_service')))])],
    intents: { ...inferred.intents, ...(source.intents || signals.intents || {}) },
    snapshot: Object.keys(snapshot).length ? snapshot : inferred.snapshot,
    live: { ...(Object.keys(source.live || signals.live || {}).length ? (source.live || signals.live) : inferred.live), activeRideCount: Number((source.live || signals.live || {}).activeRideCount ?? snapshot.activeRideCount ?? inferred.live.activeRideCount) },
    history: { ...(source.history || signals.history || {}) },
    conversation: Array.isArray(source.conversation) ? source.conversation.slice(-6) : []
  };
}

const result = (rule, action, reply, options = {}) => ({
  rule, action, reply,
  source: 'rules',
  executable: options.executable ?? false,
  needsHuman: options.needsHuman ?? false,
  risk: options.risk ?? 'normal',
  managerAction: options.managerAction || null,
  reason: options.reason || ''
});

export function evaluateRules(input) {
  const data = normalizeInput(input);
  const { flags, intents, snapshot, live, history } = data;
  const zone = snapshot.zone || {};
  const ride = snapshot.ride || {};
  const iot = snapshot.iot || {};
  const zoneVerdict = zone.verdict || 'none';
  const activeRide = live.activeRideCount === 1 || has(flags, 'active_ride');
  const knownAllowedZone = ['service', 'allowed'].includes(zoneVerdict) || has(flags, 'zone_service');
  const forbidden = has(flags, 'zone_forbidden') || ['black', 'red'].includes(zoneVerdict);
  const paid = has(flags, 'zone_paid') || zoneVerdict === 'paid';
  const incident = has(flags, 'incident') || snapshot.airraid === true;
  const finish = intents.finish === true;
  const broken = intents.broken === true;
  const balanceOut = intents.balanceOut === true;
  const dispute = intents.fineDispute === true || intents.zoneFineDispute === true;
  const zoneIssue = intents.zoneStuck === true || intents.zoneEngaged === true;
  const money = Number(ride.amt || 0) > 0;
  const noMovement = has(flags, 'not_moved') && has(flags, 'motor_unused');
  const iotError = has(flags, 'iot_err');
  const unlockFailed = has(flags, 'unlock_failed');
  const gpsDispute = /червон|красн|запрещ|заборон|локац|по факту|не можу закінчити|не могу закончить/.test(data.text.toLowerCase());
  const risk = has(flags, 'risk') || has(flags, 'tag_risk') || has(flags, 'tag_scam');
  const repeated = Number(history.r14Claims30d || 0) >= 2;

  if (has(flags, 'cat_deletion')) return result('R1', 'send_template_close', 'Запрос на удаление аккаунта принят. Перед закрытием проверим данные.', { executable: true, reason: 'Удаление аккаунта.' });
  if (incident && forbidden && (dispute || finish || zoneIssue || money)) return result('R10', 'fine_waive_flag', 'Из-за ограничений зоны и чрезвычайной ситуации передаём начисление на пересмотр оператору.', { executable: true, needsHuman: true, risk: 'money', reason: 'Чрезвычайная ситуация и запрещённая зона.' });
  if ((has(flags, 'offline') || (has(flags, 'new_user') && incident)) && !activeRide) return result('R7', 'template_and_flag', 'Похоже, пополнение или бронирование не завершилось поездкой. Напишите сумму и время операции, чтобы менеджер проверил платёж.', { needsHuman: true, risk: 'money', managerAction: 'Пошёл запрос менеджеру', reason: 'Операция выполнена без подтверждённой поездки.' });
  if (balanceOut && !broken) return result('R7', 'template_and_flag', 'Понимаю, что вы хотите вернуть деньги на карту. Напишите сумму, дату или время операции и что произошло, чтобы менеджер проверил платёж.', { needsHuman: true, risk: 'money', managerAction: 'Пошёл запрос менеджеру', reason: 'Возврат требует проверки платежа.' });
  if (activeRide && incident && zoneVerdict === 'service' && !broken) return result('R9', 'gps_recheck_then_refund', 'Проверьте, пожалуйста, что транспорт стоит в месте, которое приложение показывает как разрешённое. Из-за тревоги и возможной ошибки GPS передаём ситуацию на повторную проверку.', { needsHuman: true, risk: 'money', managerAction: 'Пошёл запрос менеджеру', reason: 'Активная поездка и тревога требуют GPS-проверки.' });
  if (activeRide && zoneVerdict === 'service' && finish && gpsDispute && !broken) return result('R9', 'gps_recheck_then_refund', 'Похоже, приложение и фактическое место парковки показывают разные статусы. Проверьте отметку зоны и не оставляйте транспорт, пока статус завершения не подтвердился; случай передаём на GPS-проверку.', { needsHuman: true, risk: 'money', managerAction: 'Пошёл запрос менеджеру', reason: 'Активная поездка и конфликт статуса зоны.' });
  if (activeRide && knownAllowedZone && input.text && !forbidden && !incident) return result('GR1', broken ? 'grace_fallback' : 'grace_offer', 'Похоже, поездку не удаётся завершить обычным способом. Проверьте в приложении статус поездки и место парковки. Если транспорт неисправен или приложение не принимает завершение, напишите текст ошибки.', { reason: 'Активная поездка требует сценария grace.' });
  if (finish && activeRide && knownAllowedZone && !broken) return result('R5', 'finish_ride', paid ? 'По данным приложения, вы находитесь в разрешённой зоне, поэтому поездку можно завершить. Перед подтверждением проверьте экран завершения: для платной зоны может отображаться дополнительная сумма. Если кнопка не сработает, напишите сюда, и я помогу разобраться.' : 'По данным приложения, вы находитесь в разрешённой зоне. Откройте экран текущей поездки и нажмите «Завершить поездку». После подтверждения дождитесь статуса «Поездка завершена». Если кнопка не сработает, напишите, что именно видите на экране.', { executable: true, reason: 'Разрешённая зона подтверждена сигналами.' });
  if (noMovement) return result('R3', 'escalate_refund', 'Понимаю, как неприятно увидеть списание, если поездка фактически не началась. По данным транспорта движения не было. Опишите, пожалуйста, когда вы разблокировали транспорт и сколько было списано. Я передам эти детали менеджеру для проверки возврата.', { needsHuman: true, risk: 'money', managerAction: 'Пошёл запрос менеджеру', reason: 'Датчики показывают отсутствие поездки.' });
  if (unlockFailed && iotError) return result('R4', 'repair_and_payment_review', 'Понимаю, как неприятно потратить время на разблокировку и не начать поездку. Похоже, замок и транспорт передали техническую ошибку. Не пытайтесь повторно разблокировать этот транспорт: я передам заявку технику и попрошу менеджера отдельно проверить возможное списание.', { needsHuman: true, risk: 'money', managerAction: 'Пошёл запрос менеджеру', reason: 'Ошибка разблокировки и IoT.' });
  if (activeRide && broken && !forbidden && !incident && input.text) return result('GR1', 'grace_fallback', 'Похоже, транспорт перестал работать во время поездки. Остановитесь безопасно и напишите, что показывает приложение. Я помогу зафиксировать проблему и завершить поездку корректно.', { reason: 'Активная поездка и неисправность требуют grace-сценария.' });
  if (broken && iotError && !unlockFailed) return result('R8', 'repair_task_and_flag', 'Жаль, что транспорт подвёл вас во время поездки. Я зафиксировал обращение и передам его в техническую службу. Если поездка уже началась и деньги списались, менеджер дополнительно проверит начисление. Пожалуйста, не продолжайте поездку на этом транспорте.', { needsHuman: true, managerAction: 'Пошёл запрос менеджеру', reason: 'Жалоба подтверждена сигналом IoT.' });
  if (broken && !iotError && !unlockFailed && iot.motorUsed === true && iot.moved === true) return result('R-F4', 'verify_ask_details', 'Опишите, что именно не работает, и по возможности приложите фото. Автоматический возврат пока не выполняем.', { needsHuman: true, reason: 'Датчики не подтверждают неисправность.' });
  if (money && forbidden && !activeRide) return result('R14', 'escalate_refund', zone.borderline === true ? 'Похоже на ошибку границы зоны. Передаём начисление на проверку возврата.' : 'Передаём начисление на проверку. Оператор сверит маршрут и основание штрафа.', { needsHuman: true, risk: 'money', reason: risk || repeated ? 'Сработала защита от повторных возвратов.' : 'Подтверждено списание в запрещённой зоне.' });
  if (paid && money) return result('R2', 'needs_gps_check', 'Проверим, как приложение определило платную зону и какое начисление относится к поездке. Сверьте в приложении место завершения и сумму операции.', { needsHuman: true, risk: 'money', managerAction: 'Пошёл запрос менеджеру', reason: 'Списание в платной зоне.' });
  if (activeRide && forbidden) return result('RN2', 'return_vehicle_flag', 'Переместите транспорт в разрешённую зону и завершите поездку там.', { executable: true, needsHuman: true, reason: 'Активная поездка в запрещённой зоне.' });
  if (has(flags, 'new_user') && has(flags, 'no_balance') && !activeRide) return result('R13', 'new_user_onboard', 'Для начала поездки пополните баланс, выберите транспорт и нажмите «Разблокировать».', { executable: true, reason: 'Новый пользователь без баланса.' });
  return null;
}

async function askModel(input, deterministicDecision = null) {
  if (!process.env.OPENAI_API_KEY) return null;
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json', 'HTTP-Referer': 'http://localhost:8787', 'X-Title': 'BikeNow Support' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', temperature: 0.2, max_tokens: 250, messages: [
      { role: 'system', content: 'Ты первая линия поддержки BikeNow для самокатов и велосипедов в Киеве. Твоя задача — не отписаться, а понять клиента и довести бытовой вопрос до решения. Отвечай на языке клиента, тепло, естественно и кратко, обычно в 2–5 предложениях. Учитывай предыдущие сообщения и разговорные, короткие, неграмотные или смешанные формулировки. Сначала определи намерение: старт поездки, разблокировка, движение, завершение, зона, приложение, тариф или другое. Информационные вопросы «как оплатить», «сколько стоит», «какие способы оплаты» и «где посмотреть тариф» решай сам по базе знаний, не передавай менеджеру. Эскалируй только фактический спор о списании, возврате, штрафе или компенсации, а также угрозы, травмы, агрессию, юридические претензии, взлом/доступ к аккаунту и персональные данные. Если намерение вероятно, дай практические шаги и не задавай лишний вопрос. Если намерение неясно, задай один конкретный вопрос с 2–4 вариантами ответа и продолжи диалог после ответа клиента. Никогда не говори «не найдено правило», «я не понял» или «передаю оператору» из-за одной неясной фразы. Не выдумывай цены, статусы, сроки, наличие транспорта или действия в аккаунте. Не проси пароль, полный номер карты, CVV, коды из SMS, документы или точную геолокацию. Не обещай возврат, списание, изменение поездки или компенсацию.' },
      { role: 'system', content: 'Проверка достоверности: не утверждай состояние зоны, поездки, оплаты или аккаунта, если оно явно не подтверждено входными signals или базой знаний. Используй «по данным приложения», «проверьте» и «если», когда факт неизвестен. Информационные вопросы о цене и способах оплаты не являются спором о деньгах. Отвечай на любой безопасный вопрос, даже если он не связан с BikeNow, затем мягко возвращай разговор к сервису. Не создавай эскалацию только потому, что клиент написал коротко, с ошибками или не по шаблону.' },
      { role: 'system', content: 'Пиши каждый ответ заново под конкретную реплику и историю, избегай одинаковых заготовок и слов «обычно», если точной информации нет. Для регистрации, телефона и SMS используй только подтверждённые данные из knowledgeBase; если точной процедуры BikeNow в базе нет, честно скажи, что не хочешь придумывать инструкцию, и уточни экран или текст ошибки. Не говори «черновик AI» клиенту и не добавляй лишние рекламные фразы. При первом сообщении о штрафе, возврате или списании сначала спокойно задай один уточняющий вопрос и помоги разобраться; не призывай менеджера и не показывай кнопку, пока клиент не подтвердит проблему или явно не попросит человека.' },
      { role: 'system', content: 'Приветствуй клиента только в самом первом ответе диалога. В продолжении сразу отвечай по сути и не начинай каждое сообщение одинаково.' },
      { role: 'user', content: JSON.stringify({
        currentMessage: input.text,
        conversation: input.conversation,
        signals: { flags: input.flags, intents: input.intents, snapshot: input.snapshot, live: input.live },
        knownFacts: {
          zone: input.snapshot?.zone?.verdict || 'unknown',
          activeRideCount: input.live?.activeRideCount ?? 'unknown'
        },
        deterministicDecision,
        knowledgeBase: KNOWLEDGE_BASE
      }) }
    ] })
  });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    const detail = errorBody.error?.message || errorBody.error?.type || 'проверьте квоту и настройки API';
    throw new Error(`LLM HTTP ${response.status}: ${detail}`);
  }
  const body = await response.json();
  return body.choices?.[0]?.message?.content?.trim() || null;
}

export async function answer(body) {
  const input = normalizeInput(body);
  const rule = evaluateRules(input);
  const escalation = detectEscalation(input.text);
  const offerManager = shouldOfferManager(input, escalation, rule);
  try {
    const reply = await askModel(input, rule);
    if (reply) return { rule: rule?.rule || 'LLM', action: rule?.action || 'answer_question', reply: sanitizeReply(reply, input), source: 'llm', executable: rule?.executable ?? false, needsHuman: Boolean(escalation || rule?.needsHuman), risk: escalation?.risk || rule?.risk || 'normal', managerAction: offerManager ? 'Пошёл запрос менеджеру' : null, reason: 'Каждое сообщение обработано AI на основе базы знаний.', input };
  } catch (error) {
    if (rule?.reply) return { ...rule, source: 'rules-fallback', managerAction: offerManager ? 'Пошёл запрос менеджеру' : null, input, reason: `AI недоступен: ${error.message}` };
    return { rule: 'AI_UNAVAILABLE', action: 'retry_ai', reply: 'Сообщение не потерялось. Я не хочу придумывать ответ без проверки, поэтому попробуйте отправить его ещё раз через несколько секунд.', source: 'fallback', executable: false, needsHuman: Boolean(escalation), risk: escalation?.risk || 'normal', managerAction: offerManager ? 'Пошёл запрос менеджеру' : null, reason: `AI недоступен: ${error.message}`, input };
  }
  if (rule?.reply) return { ...rule, source: 'rules-fallback', managerAction: offerManager ? 'Пошёл запрос менеджеру' : null, input, reason: 'AI не вернул ответ.' };
  return { rule: 'AI_UNAVAILABLE', action: 'retry_ai', reply: 'Сообщение не потерялось. Я не хочу придумывать ответ без проверки, поэтому попробуйте отправить его ещё раз через несколько секунд.', source: 'fallback', executable: false, needsHuman: Boolean(escalation), risk: escalation?.risk || 'normal', managerAction: offerManager ? 'Пошёл запрос менеджеру' : null, reason: 'AI не вернул ответ.', input };
}

export function managerRequest(body = {}) {
  const input = normalizeInput(body);
  return {
    ok: true,
    status: 'sent',
    message: 'Пошёл запрос менеджеру. Мы проверим обращение и ответим в этом чате.',
    receivedAt: new Date().toISOString(),
    text: input.text
  };
}

async function staticFile(req, res) {
  const requested = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  if (/\/\.env(?:\s|%20|$)/i.test(requested)) { res.writeHead(404); return res.end('Not found'); }
  const path = normalize(join(PUBLIC, requested));
  if (!path.startsWith(PUBLIC)) return res.end('Forbidden');
  try {
    const body = await readFile(path);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
}

export const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/answer') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      try { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(await answer(JSON.parse(raw)))); }
      catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/manager-request') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(managerRequest(JSON.parse(raw)))); }
      catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
    });
    return;
  }
  if (req.method === 'GET') return staticFile(req, res);
  res.writeHead(405); res.end('Method not allowed');
});

if (process.argv[1] === fileURLToPath(import.meta.url)) server.listen(PORT, () => console.log(`BikeNow agent: http://localhost:${PORT}`));
