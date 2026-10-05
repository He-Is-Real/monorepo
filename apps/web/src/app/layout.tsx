import './global.css';

export const metadata = {
  title: 'He Is Real Today',
  description: 'Real stories of encounters with God.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
