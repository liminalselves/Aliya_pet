import type { ChatEvent, ChatProvider, ChatRequest } from './types';

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return; }
    const abort = () => { clearTimeout(timer); reject(new Error('aborted')); };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** 本地演示，不进行网络请求，也不冒充真实模型。 */
export class MockChatProvider implements ChatProvider {
  readonly label = '本地演示 · 尚未连接 AI';

  async *reply({ messages, signal }: ChatRequest): AsyncIterable<ChatEvent> {
    const input = messages[messages.length - 1]?.text ?? '';
    await delay(/慢响应/.test(input) ? 3500 : 850, signal);
    if (/测试失败/.test(input)) throw new Error('演示请求失败，请重试。');
    const segments = /累|难过|不开心/.test(input)
      ? [
          { text: '辛苦啦。先停一小会儿，我在这里陪你。', cue: { expression: 'worried' } },
          { text: '等连接好以后，我就能认真听你讲今天的事情了。现在这段是本地演示回复。', cue: { expression: 'happy', action: 'nod' } },
        ]
      : /长回复/.test(input)
        ? [
            { text: '我们慢慢聊，不急着把所有的话都说完。', cue: { expression: 'happy', action: 'nod' } },
            { text: '这是一段较长的本地演示，用来看看文字换行、滚动和阅读的感觉。你可以选择文字、复制这次回复，也可以打开历史，回看刚刚说过的话。', cue: { expression: 'serious' } },
            { text: '摸摸我的头也没关系，动作会先回应你的触碰。对话内容会留在这里，不会被普通台词盖住。', cue: { expression: 'shy' } },
            { text: '收起面板以后，我还是会待在桌面上。等你再打开，我们的记录也还在。', cue: { expression: 'happy' } },
          ]
        : /你好|嗨|在吗/.test(input)
          ? [
              { text: '我在呀。很高兴在这里见到你。', cue: { expression: 'happy', action: 'wave' } },
              { text: '以后我们就可以这样聊天了。现在还没有连接 AI，这次先陪你试试新的对话界面。', cue: { expression: 'shy' } },
            ]
          : [
              { text: '嗯，我看到你写的话了。', cue: { expression: 'happy', action: 'nod' } },
              { text: '目前我只会演示预设回复，还不能真正理解或回答问题。连接好 AI 后，我们就在这里继续聊。', cue: { expression: 'serious' } },
            ];
    for (let i = 0; i < segments.length; i++) {
      if (signal.aborted) return;
      yield { type: 'segment', id: String(i), ...segments[i] };
      await delay(Math.min(2600, 700 + segments[i].text.length * 25), signal);
    }
    yield { type: 'done' };
  }
}
