import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api, AuthUser, getToken, setToken } from './api';

interface AuthState { user: AuthUser | null; organization: any; loading: boolean; login: (email: string, password: string) => Promise<void>; logout: () => void; refresh: () => Promise<void> }
const Ctx = createContext<AuthState>(null as any);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [organization, setOrg] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    if (!getToken()) { setUser(null); setOrg(null); setLoading(false); return; }
    try { const me = await api.get('/api/auth/me'); setUser(me.user); setOrg(me.organization); }
    catch { setToken(''); setUser(null); setOrg(null); }
    finally { setLoading(false); }
  };
  useEffect(() => { refresh(); }, []);
  const login = async (email: string, password: string) => {
    const r = await api.post('/api/auth/login', { email, password });
    setToken(r.token); setUser(r.user); setOrg(r.organization);
  };
  const logout = () => { setToken(''); setUser(null); setOrg(null); };
  return <Ctx.Provider value={{ user, organization, loading, login, logout, refresh }}>{children}</Ctx.Provider>;
}
export const useAuth = () => useContext(Ctx);
