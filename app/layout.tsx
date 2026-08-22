import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { AgeGate } from "@/components/age-gate";

/**
 * Archivo carries display and body in different weights — a grotesque with
 * enough character to avoid the default-app look, paired on a genuine
 * contrast axis with a mono rather than with a second, similar sans.
 */
const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  display: "swap",
});

/** Everything measurable is mono: detours, distances, dates, coordinates. */
const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Ontario Beer Survey",
  description:
    "Find the Ontario breweries worth your time — matched to the beer you actually like, along your route or around where you're staying.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${plexMono.variable} h-full`}
    >
      <body className="h-full overflow-hidden bg-bg text-ink">
        <AgeGate />
        {children}
      </body>
    </html>
  );
}
