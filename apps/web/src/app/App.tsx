import { RouterProvider } from "react-router-dom";
import { ThemeProvider } from "@/shared/ui/themeProvider";
import { TooltipProvider } from "@/shared/ui/Tooltip";
import { router } from "./routes";
import { AuthProvider } from "@/features/auth/AuthProvider";

export function App() {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider><RouterProvider router={router} /></AuthProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
