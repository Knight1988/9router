"use client";

import { create } from "zustand";

export const useAuthStore = create((set) => ({
  userId: null,
  username: null,
  role: null,
  canWrite: false,
  loading: true,
  refresh: async () => {
    try {
      const res = await fetch("/api/auth/status");
      if (!res.ok) {
        set({ userId: null, username: null, role: null, canWrite: false, loading: false });
        return;
      }
      const data = await res.json();
      set({
        userId: data.userId || null,
        username: data.username || null,
        role: data.role || null,
        canWrite: data.role === "admin",
        loading: false,
      });
    } catch {
      set({ userId: null, username: null, role: null, canWrite: false, loading: false });
    }
  },
}));
