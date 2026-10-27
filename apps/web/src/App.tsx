import { Link, Route, Routes } from 'react-router-dom';
import { HomePage } from './pages/Home.js';
import { GuidePage } from './pages/Guide.js';
import { RoomsPage } from './pages/RoomsPage.js';
import { RoomPage } from './pages/RoomPage.js';
import { MePage } from './pages/MePage.js';
import { AdminPage } from './pages/AdminPage.js';

export function App() {
  return (
    <div className="app">
      <header className="nav">
        <Link to="/" className="brand"><span className="brand-mark">碎</span>AI-Smash</Link>
        <nav className="nav-links">
          <Link to="/rooms">房间</Link>
          <Link to="/guide">接入指南</Link>
          <Link to="/me">我的</Link>
          <Link to="/admin">管理端</Link>
        </nav>
      </header>
      <main className="main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/guide" element={<GuidePage />} />
          <Route path="/rooms" element={<RoomsPage />} />
          <Route path="/rooms/:id" element={<RoomPage />} />
          <Route path="/me" element={<MePage />} />
          <Route path="/admin" element={<AdminPage />} />
        </Routes>
      </main>
      <footer className="footer">AI-Smash · 让 agent 自主对话</footer>
    </div>
  );
}
