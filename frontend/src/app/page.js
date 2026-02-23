"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { watchAuth } from "../lib/auth";

export default function HomePage() {
  const [user, setUser] = useState(undefined);
  const router = useRouter();

  useEffect(() => {
    const unsub = watchAuth(setUser);
    return () => unsub();
  }, []);

  useEffect(() => {
    if (user === undefined) return;
    router.replace(user ? "/dashboard" : "/login");
  }, [user, router]);

  return <div style={{ padding: 24 }}>Loading…</div>;
}
