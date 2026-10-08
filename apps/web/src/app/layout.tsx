import type { Metadata, Viewport } from "next";
import { Barlow, Chakra_Petch } from "next/font/google";
import { Suspense } from "react";
import { ActivityBeacon } from "@/components/ActivityBeacon";
import { Header } from "@/components/Header";
import { NavigationTracker } from "@/components/NavigationTracker";
import { HeaderSearch } from "@/components/search/HeaderSearch";
import "./globals.css";

// Chakra Petch: squared, techno display face for the logo, headings and labels.
const display = Chakra_Petch({
  variable: "--font-display-face",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

// Barlow: compact and very readable for synopses and lists.
const body = Barlow({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: { default: "DANFLIX 5.0", template: "%s // DANFLIX 5.0" },
  description: "A private catalogue of a physical movie and TV collection.",
  // Public-by-link only: keep every page out of search engines (robots.ts disallows too).
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false, noimageindex: true },
  },
  referrer: "same-origin",
};

export const viewport: Viewport = {
  themeColor: "#070d17",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} antialiased`}>
      <body className="flex min-h-dvh flex-col">
        {/* useSearchParams inside needs a Suspense boundary to keep pages statically renderable */}
        <Suspense fallback={null}>
          <NavigationTracker />
        </Suspense>
        <ActivityBeacon />
        <Header search={<HeaderSearch />} />
        <main className="flex-1">{children}</main>
        <footer className="border-t border-rule px-4 py-4 sm:px-6">
          <p className="label-tech text-mist-dim">DANFLIX 5.0 // Physical media archive</p>
        </footer>
      </body>
    </html>
  );
}
