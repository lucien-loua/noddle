import {
  ArchiveIcon,
  BellIcon,
  FolderIcon,
  HardDrivesIcon,
  HouseIcon,
  KeyIcon,
  PackageIcon,
  ScrollIcon,
  SignOutIcon,
  SquaresFourIcon,
  StackIcon,
  UsersIcon,
} from "@phosphor-icons/react";
import {
  Link,
  type LinkProps,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useCallback } from "react";
import { NoddleMark } from "@/components/noddle-mark";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";
import { type RoleName, roles } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";

interface Props {
  actions?: ReactNode;
  /** The path leading to this screen, when it is nested. Rendered IN PLACE
   *  of the title: on a detail page, "where am I" and "how do I go back up"
   *  are the same question, and two competing headers would answer it
   *  twice. */
  breadcrumb?: ReactNode;
  children: ReactNode;
  email?: string | null;
  /** Used ONLY to hide the "Audit" entry. The real refusal is server-side,
   *  in `getAuditLog` — this is only a courtesy, as everywhere else. Absent
   *  = entry hidden, which is the safe default.
   *
   *  `string | null` rather than `RoleName`, like the other components that
   *  receive a role: it comes from a text column, so narrowing it happens
   *  HERE rather than forcing every caller to vouch for its value. */
  role?: string | null;
  title: string;
}

function NavItem({
  active,
  icon: Icon,
  label,
  to,
}: {
  active: boolean;
  icon: typeof HouseIcon;
  label: string;
  to: LinkProps["to"];
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        render={<Link to={to} />}
        tooltip={label}
      >
        <Icon weight={active ? "fill" : "regular"} />
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AppShell({
  actions,
  breadcrumb,
  children,
  email,
  role,
  title,
}: Props) {
  const knownRole = role && role in roles ? (role as RoleName) : null;
  const canReadAudit = useCan(knownRole, "audit", "read");
  const canReadSshKey = useCan(knownRole, "sshKey", "read");
  const canReadRegistry = useCan(knownRole, "registry", "read");
  const router = useRouter();
  const pathname = useRouterState({
    select: (s) => s.location.pathname,
  });

  const handleSignOut = useCallback(async () => {
    await authClient.signOut();
    await router.invalidate();
    await router.navigate({ to: "/login" });
  }, [router]);

  const onDashboard = pathname === "/";

  return (
    // Viewport height LOCKED, not merely minimal: with the "inset" variant,
    // the card must stay planted on screen and scroll from the inside.
    // Otherwise the whole page scrolls and the card — its rounded corners,
    // its header — drifts upward.
    <SidebarProvider className="h-svh overflow-hidden">
      <Sidebar collapsible="icon" variant="inset">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                // Collapsed, `lg` becomes `p-0!` and keeps `justify-start`.
                className="group-data-[collapsible=icon]:justify-center"
                render={<Link to="/" />}
                size="lg"
              >
                <NoddleMark className="size-6! shrink-0" />
                <span className="font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
                  Noddle
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        {/* Measured: 0 navigation landmark across the six screens. Placed
            here and not in `ui/sidebar.tsx`, which `shadcn add` overwrites
            wholesale. */}
        <SidebarContent aria-label="Main" role="navigation">
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <NavItem
                  active={onDashboard}
                  icon={HouseIcon}
                  label="Overview"
                  to="/"
                />
                <NavItem
                  active={pathname.startsWith("/deployments")}
                  icon={SquaresFourIcon}
                  label="Deployments"
                  to="/deployments"
                />
                <NavItem
                  active={pathname.startsWith("/projects")}
                  icon={FolderIcon}
                  label="Projects"
                  to="/projects"
                />
                <NavItem
                  active={pathname.startsWith("/servers")}
                  icon={HardDrivesIcon}
                  label="Servers"
                  to="/servers"
                />
                <NavItem
                  active={pathname.startsWith("/containers")}
                  icon={StackIcon}
                  label="Containers"
                  to="/containers"
                />
                {/* Hidden without `sshKey: read` — so for `viewer` and
                    `deployer`. A courtesy, as everywhere: the real refusal
                    is in `getSshKeys`. */}
                {/* Hidden without the read permission. A courtesy, as
                    everywhere: the real refusal is in the server
                    function. */}
                {canReadSshKey ? (
                  <NavItem
                    active={pathname.startsWith("/ssh-keys")}
                    icon={KeyIcon}
                    label="SSH keys"
                    to="/ssh-keys"
                  />
                ) : null}
                {canReadRegistry ? (
                  <NavItem
                    active={pathname.startsWith("/registries")}
                    icon={PackageIcon}
                    label="Registries"
                    to="/registries"
                  />
                ) : null}
                <NavItem
                  active={pathname.startsWith("/destinations")}
                  icon={ArchiveIcon}
                  label="S3 destinations"
                  to="/destinations"
                />
                <NavItem
                  active={pathname.startsWith("/notifications")}
                  icon={BellIcon}
                  label="Notifications"
                  to="/notifications"
                />
                <NavItem
                  active={pathname.startsWith("/accounts")}
                  icon={UsersIcon}
                  label="Accounts"
                  to="/accounts"
                />
                {canReadAudit ? (
                  <NavItem
                    active={pathname.startsWith("/audit")}
                    icon={ScrollIcon}
                    label="Audit"
                    to="/audit"
                  />
                ) : null}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            {email ? (
              <SidebarMenuItem>
                <span className="block truncate px-2 py-1 text-sidebar-foreground/60 text-xs group-data-[collapsible=icon]:hidden">
                  {email}
                </span>
              </SidebarMenuItem>
            ) : null}
            <SidebarMenuItem>
              <ThemeToggle />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={handleSignOut} tooltip="Sign out">
                <SignOutIcon />
                <span>Sign out</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      {/* `min-h-0`: without it, a `flex-1` child refuses to shrink below
          its content height and overflows instead of scrolling. */}
      <SidebarInset className="min-h-0 overflow-hidden">
        {/* Sticky: on a screen you scroll through, the create action and
            the sidebar's collapse toggle must stay reachable without
            scrolling back up. */}
        {/* The header doesn't scroll because it's OUTSIDE the container
            that scrolls, not because it's `sticky`: nothing can pass
            beneath it. */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ms-1" size="icon" />
          {breadcrumb ?? (
            <h1 className="font-medium text-sm tracking-tight">{title}</h1>
          )}
          <div className="ms-auto flex min-w-0 items-center gap-2">
            {actions}
          </div>
        </header>
        {/* `scroll-fade` is driven by scroll position: the gradient only
            appears if there's still something to scroll toward on that
            side. It replaces the scrollbar, which `no-scrollbar` removes —
            without it, nothing would indicate there's more to see. */}
        <div className="scroll-fade no-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
