export const VIBE_BUTTON_TSX = `import React from 'react';

interface ButtonProps {
  onClick: () => void;
  children: React.ReactNode;
  variant?: 'primary' | 'danger';
}

export function Button({ onClick, children, variant = 'primary' }: ButtonProps) {
  return (
    <button className={\`btn btn-\${variant}\`} onClick={onClick}>
      {children}
    </button>
  );
}
`;

export const VIBE_APP_TSX = `import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from './Button.tsx';

interface Todo {
  id: number;
  text: string;
  done: boolean;
}

function App() {
  const [todos, setTodos] = useState<Todo[]>([
    { id: 1, text: '体验一下 Super Agent 生成的应用', done: false },
    { id: 2, text: '试试在真实模型上让它做别的页面', done: false },
  ]);
  const [input, setInput] = useState('');

  function add() {
    if (!input.trim()) return;
    setTodos([...todos, { id: Date.now(), text: input, done: false }]);
    setInput('');
  }

  function toggle(id: number) {
    setTodos(todos.map(t => t.id === id ? { ...t, done: !t.done } : t));
  }

  function remove(id: number) {
    setTodos(todos.filter(t => t.id !== id));
  }

  const remaining = todos.filter(t => !t.done).length;

  return (
    <div className="container">
      <h1>📝 我的待办清单</h1>
      <p className="subtitle">还有 {remaining} 件事没做</p>

      <div className="input-row">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          placeholder="输入新的待办事项..."
        />
        <Button onClick={add}>添加</Button>
      </div>

      <ul className="todo-list">
        {todos.map(todo => (
          <li key={todo.id} className={todo.done ? 'done' : ''}>
            <span onClick={() => toggle(todo.id)}>{todo.text}</span>
            <Button variant="danger" onClick={() => remove(todo.id)}>×</Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
`;

export const VIBE_STYLES_CSS = `* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  min-height: 100vh;
  padding: 40px 20px;
  color: #333;
}

.container {
  max-width: 480px;
  margin: 0 auto;
  background: white;
  border-radius: 16px;
  padding: 32px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.2);
}

h1 { font-size: 28px; margin-bottom: 8px; }
.subtitle { color: #888; margin-bottom: 24px; font-size: 14px; }

.input-row { display: flex; gap: 8px; margin-bottom: 20px; }

.input-row input {
  flex: 1; padding: 10px 14px; border: 1px solid #e0e0e0;
  border-radius: 8px; font-size: 14px; outline: none;
}
.input-row input:focus { border-color: #667eea; }

.btn {
  padding: 10px 16px; border: none; border-radius: 8px;
  cursor: pointer; font-size: 14px; font-weight: 500;
  transition: transform 0.1s;
}
.btn:hover { transform: translateY(-1px); }
.btn-primary { background: #667eea; color: white; }
.btn-danger { background: #ff6b6b; color: white; padding: 4px 10px; }

.todo-list { list-style: none; }
.todo-list li {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 0; border-bottom: 1px solid #f0f0f0;
}
.todo-list li span { cursor: pointer; flex: 1; }
.todo-list li.done span { text-decoration: line-through; color: #aaa; }
`;
