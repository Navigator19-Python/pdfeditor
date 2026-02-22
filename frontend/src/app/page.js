"use client";

import { useEffect, useState } from "react";
import { watchAuth } from "../lib/auth";
import { useRouter } from "next/navigation";

export default function Home() {
  const [user, setUser] = useState(null);
  const router = useRouter();

  useEffect(() => {
    const unsub = watchAuth(setUser);
    return () => unsub();
  }, []);

  useEffect(() => {
    if (user === null) return;
    router.push(user ? "/dashboard" : "/login");
  }, [user, router]);

  return (
    <div style={{ padding: 24 }}>
      Loading...
    </div>
  );
}
