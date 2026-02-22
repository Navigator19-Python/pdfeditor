import { onAuthStateChanged } from "firebase/auth";
import { auth } from "./firebase";

export function watchAuth(setUser) {
  return onAuthStateChanged(auth, (u) => setUser(u));
}
