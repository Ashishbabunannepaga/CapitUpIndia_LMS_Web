// Re-mounts on every navigation inside the app, so each page fades in.
export default function AppTemplate({ children }: { children: React.ReactNode }) {
  return <div className="animate-page">{children}</div>;
}
