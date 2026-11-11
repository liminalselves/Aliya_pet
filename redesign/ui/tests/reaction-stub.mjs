/**
 * 测试用反应组库：每个触发键都有一组反应，台词文本 = 触发键，
 * 方便断言「哪个触发键说了话」。actionFor 可为触发键指定动作（缺省无动作，只走缺省微动）。
 */
export function reactionStub({ actionFor = () => undefined, expressionFor = () => 'happy', missing = [], known = null } = {}) {
  return {
    has: key => !missing.includes(key) && (!known || known.includes(key)),
    lineCount: () => 1,
    setExcludedTags() {},
    pick(key, { withLine = true } = {}) {
      if (missing.includes(key) || (known && !known.includes(key))) return null;
      const group = { id: key, action: actionFor(key), expression: expressionFor(key) };
      return { group, line: withLine ? { entryId: key, finalText: key, pages: [{ index: 0, text: key }] } : null };
    },
  };
}

/** InteractionService 的呈现宿主：台词走 speak，Live2D 动作记入 actions。 */
export function reactionHost({ canSpeak = () => true, speak = () => {}, actions = [], expressions = [] } = {}) {
  return {
    canSpeak,
    speak,
    express: name => expressions.push(name),
    playMotion: name => { actions.push(name); return true; },
  };
}
