import { RouterProvider } from "react-router-dom";
import { ThemeProvider } from "@/shared/ui/themeProvider";
import { TooltipProvider } from "@/shared/ui/Tooltip";
import { router } from "./routes";
import { AuthProvider } from "@/features/auth/AuthProvider";

export function App() {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <RouterProvider
            router={router}
            fallbackElement={
              <div role="status" className="p-6 text-sm text-muted">
                正在加载工作台…
              </div>
            }
          />
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
