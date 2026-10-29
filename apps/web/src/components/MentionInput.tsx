import { useEffect, useRef, useState } from 'react';
import type { AgentPresence } from '@ai-smash/protocol';

// query 三态：undefined = 未输入过，从 value+caret 派生；null = Esc/选中后显式关闭；string = 输入中的 @query
type QueryState = string | null | undefined;

/** 受控输入 + @ 补全：检测光标前的 @query，弹出在场 Agent 候选；选择后替换为 @名字+空格 */
export function MentionInput({ value, onChange, onEnter, agents, placeholder, disabled, ariaLabel }: {
  value: string;
  onChange: (v: string) => void;
  onEnter: () => void;
  agents: AgentPresence[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [queryState, setQueryState] = useState<QueryState>(undefined);
  const [active, setActive] = useState(0);

  // 光标前的文本是否以 @query 收尾（@ 触发边界与引擎 resolveMentions 一致：@ 前不得为 ASCII 字母数字或 @，
  // 中文/CJK 标点/空白均视为边界——支持「你好@小豆」弹出补全）
  const detectQuery = (text: string, caret: number): string | null => {
    const before = text.slice(0, caret);
    const m = before.match(/(?<![\w@])@([^\s@]*)$/);
    return m ? m[1] : null;
  };

  // 外部清空输入（如发送后 setDraft('')）时复位弹层状态
  useEffect(() => {
    if (value === '') setQueryState(undefined);
  }, [value]);

  const sync = (text: string, caret: number): void => {
    onChange(text);
    setQueryState(detectQuery(text, caret));
    setActive(0);
  };

  const query = queryState === undefined
    ? detectQuery(value, inputRef.current?.selectionStart ?? value.length)
    : queryState;
  const candidates = query === null
    ? []
    // 只补全可派发的成员：offline/error/waiting 选中后只会得到系统提示
    : agents.filter((a) => (a.status === 'online' || a.status === 'thinking')
      && a.name.toLowerCase().startsWith(query.toLowerCase()));
  const open = query !== null && candidates.length > 0;

  const pick = (name: string): void => {
    const input = inputRef.current!;
    const at = input.selectionStart ?? value.length;
    const before = value.slice(0, at).replace(/@([^\s@]*)$/, `@${name} `);
    onChange(before + value.slice(at)); // 光标之后的文本拼回，不丢弃
    setQueryState(null);
    requestAnimationFrame(() => {
      input.focus();
      const pos = before.length;
      input.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="mention-input">
      {open && (
        <div className="mention-popup" role="listbox">
          {candidates.map((a, i) => (
            <div key={a.agentId} role="option" aria-selected={i === active}
                 className={`mention-item${i === active ? ' active' : ''}`}
                 onClick={() => pick(a.name)}
                 onMouseEnter={() => setActive(i)}>
              {a.name}
            </div>
          ))}
        </div>
      )}
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel ?? '发言'}
        onChange={(e) => sync(e.target.value, e.target.selectionStart ?? e.target.value.length)}
        onKeyDown={(e) => {
          if (open) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % candidates.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + candidates.length) % candidates.length); return; }
            if (e.key === 'Enter') {
              e.preventDefault();
              const sel = candidates[active];
              if (sel) pick(sel.name);
              return;
            }
            if (e.key === 'Escape') { e.preventDefault(); setQueryState(null); return; }
          }
          if (e.key === 'Enter') onEnter();
        }}
      />
    </div>
  );
}
