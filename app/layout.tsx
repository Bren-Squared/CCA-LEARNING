import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { getAppDb } from "@/lib/db";
import { getDarkMode } from "@/lib/settings";
import AppNav from "./AppNav";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CCA Foundations — Learning App",
  description:
    "Single-user study environment for the Claude Certified Architect Foundations exam.",
};

// NFR5.3 — dark-mode preference lives in settings.dark_mode. Reading it in the
// root layout means every page is stamped on the server so there's no FOUC
// flash when Tailwind's `dark:` variants apply on first paint.
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const darkMode = getDarkMode(getAppDb());
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased${
        darkMode ? " dark" : ""
      }`}
    >
      <body className="min-h-full flex flex-col">
        <AppNav />
        {children}
      </body>
    </html>
  );
}
