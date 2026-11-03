import type { Metadata } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const archivo = Archivo({ variable: "--font-archivo", subsets: ["latin"], axes: ["wdth"] });
const mono = JetBrains_Mono({ variable: "--font-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Unhappy Path — crash-test your PayPal integration",
  description:
    "An AI agent that breaks your PayPal sandbox integration on purpose — declines, forged and duplicate webhooks, refunds, price tampering — and tells you if it's ready to go live.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${archivo.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}
