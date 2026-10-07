export const MAX_MICROS = 9_000_000_000_000_000;
export const problem = (status, message) => Object.assign(new Error(message), { status });

export function doubledCostMicros(value, currency) {
  if (currency !== 'CNY' || !['number', 'string'].includes(typeof value)) throw problem(502, '上游未返回有效人民币账单');
  const encoded = String(value), match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(encoded);
  if (!match || encoded.length > 80) throw problem(502, '上游费用格式不正确');
  const power = Number(match[3] || 0) - (match[2] || '').length;
  if (power < -30 || power > 20) throw problem(502, '上游费用超出范围');
  const numerator = BigInt(match[1] + (match[2] || '')) * 2_000_000n;
  const micros = power >= 0 ? numerator * 10n ** BigInt(power) : (numerator + 10n ** BigInt(-power) - 1n) / 10n ** BigInt(-power);
  if (micros > BigInt(MAX_MICROS)) throw problem(502, '上游费用超出范围');
  return Number(micros);
}
export function parseFen(value) {
  const match = /^(\d{1,5})(?:\.(\d{1,2}))?$/.exec(String(value));
  const fen = match ? Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0')) : NaN;
  if (!Number.isSafeInteger(fen) || fen < 1 || fen > 1_000_000) throw problem(400, '金额须为 0.01–10,000 元，最多两位小数');
  return fen;
}
export function maximumCharge({ input, output, bytes, tokens }) {
  for (const number of [input, output, bytes, tokens]) if (!Number.isSafeInteger(number) || number < 0) throw problem(502, '无法计算模型费用上限');
  const charge = (BigInt(input) * (BigInt(bytes) + 4096n) + BigInt(output) * BigInt(tokens) + 999999n) / 1000000n;
  if (charge > BigInt(MAX_MICROS)) throw problem(400, '请求费用超出范围');
  return Number(charge);
}
