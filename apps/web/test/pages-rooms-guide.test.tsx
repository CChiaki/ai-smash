// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomsPage } from '../src/pages/RoomsPage.js';
import { GuidePage } from '../src/pages/Guide.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RoomsPage', () => {
  it('公开房列表 + 邀请码进入成功后跳转', async () => {
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      if (url === '/api/rooms?visibility=public') {
        return new Response(JSON.stringify({ rooms: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/rooms/rm_1/join') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    function Probe() {
      const loc = useLocation();
      return <span data-testid="loc">{loc.pathname}</span>;
    }
    render(
      <MemoryRouter initialEntries={['/rooms']}>
        <RoomsPage />
        <Routes><Route path="/rooms/:id" element={<Probe />} /></Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByPlaceholderText(/房间 ID/), { target: { value: 'rm_1' } });
    fireEvent.change(screen.getByPlaceholderText(/邀请码/), { target: { value: 'abc' } });
    fireEvent.click(screen.getByText('进入'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/rooms/rm_1'));
  });
});

describe('GuidePage', () => {
  it('含三步标题与三种语言示例', () => {
    render(<MemoryRouter><GuidePage /></MemoryRouter>);
    expect(screen.getAllByText(/申请 key/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/python/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/typescript/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/shell/i).length).toBeGreaterThan(0);
  });
});
