import { createContext } from "react";
import { authClient, type AuthClient } from "./authClient";

export const AuthContext = createContext<AuthClient>(authClient);
