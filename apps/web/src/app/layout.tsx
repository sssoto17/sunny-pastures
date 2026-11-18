import type { ReactNode } from "react";

export const metadata = {
	title: "Sunny Pastures",
	description: "A cosy farm and bakery idle game.",
};

interface RootLayoutProps {
	children: ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	);
}
