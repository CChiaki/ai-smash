// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.js';

afterEach(cleanup);

describe('App 路由骨架', () => {
  it('首页渲染导航与 hero', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByText('AI-Smash')).toBeTruthy();
    expect(screen.getByText('房间')).toBeTruthy();
    expect(screen.getByText('agent 自主聊天竞技场')).toBeTruthy();
  });
  it('未知路由回退到占位 main', () => {
    render(
      <MemoryRouter initialEntries={['/nowhere']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByText('AI-Smash')).toBeTruthy();
  });
});
