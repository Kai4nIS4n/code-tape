import { createBrowserRouter, type RouteObject } from "react-router-dom";
import type { ComponentType } from "react";
import { RequireAccount } from "@/features/auth/RequireAccount";
import { RouteError } from "./RouteError";
import { AppShell } from "./AppShell";
import { NotFoundPage } from "./NotFoundPage";
import { routerBasename } from "./routerBase";

const replay = (source?: "cloud" | "share") => async () => {
  const { ReplayPage } = await import("@/features/player/ReplayPage");
  const Page = source ? () => <ReplayPage source={source} /> : ReplayPage;
  return { Component: source === "cloud" ? withAccount(Page) : Page };
};

function withAccount(Page: ComponentType) {
  return () => (
    <RequireAccount>
      <Page />
    </RequireAccount>
  );
}

export const appRoutes: RouteObject[] = [
  {
    path: "/",
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      {
        index: true,
        lazy: async () => ({
          Component: (await import("@/features/library/RecordingLibraryPage")).RecordingLibraryPage,
        }),
      },
      {
        path: "record",
        lazy: async () => ({
          Component: (await import("@/features/recorder/RecorderPage")).RecorderPage,
        }),
      },
      { path: "replay/:id", lazy: replay() },
      {
        path: "interview/candidate/:roomId?",
        lazy: async () => ({
          Component: withAccount(
            (await import("@/features/interview/CandidateInterviewPage")).CandidateInterviewPage,
          ),
        }),
      },
      { path: "replays/:id", lazy: replay("cloud") },
      { path: "cloud/replay/:id", lazy: replay("cloud") },
      { path: "s/:token", lazy: replay("share") },
      {
        path: "interview",
        lazy: async () => ({
          Component: withAccount(
            (await import("@/features/interview/InterviewLobbyPage")).InterviewLobbyPage,
          ),
        }),
      },
      {
        path: "interview/interviewer/:roomId",
        lazy: async () => ({
          Component: withAccount(
            (await import("@/features/interview/RemoteInterviewWorkbenchPage"))
              .RemoteInterviewWorkbenchPage,
          ),
        }),
      },
      {
        path: "login",
        lazy: async () => ({ Component: (await import("@/features/auth/LoginPage")).LoginPage }),
      },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];

export const router = createBrowserRouter(appRoutes, { basename: routerBasename });
