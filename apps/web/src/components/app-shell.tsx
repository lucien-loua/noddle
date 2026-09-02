import {
  ArchiveIcon,
  BellIcon,
  CaretUpDownIcon,
  FolderIcon,
  GitBranchIcon,
  HardDrivesIcon,
  HouseIcon,
  KeyIcon,
  PackageIcon,
  GearIcon,
  ScrollIcon,
  SignOutIcon,
  SquaresFourIcon,
  StackIcon,
  UsersIcon,
} from "@phosphor-icons/react";
import {
  Link,
  useRouteContext,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import type { LinkProps } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useCallback } from "react";

import { NoddleMark } from "@/components/noddle-mark";
import { ThemeToggle } from "@/components/theme-toggle";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { roles } from "@/lib/permissions";
import type { RoleName } from "@/lib/permissions";
import { useGravatarUrl } from "@/lib/use-gravatar";
import { useCan } from "@/lib/use-permission";

interface Props {
  actions?: ReactNode;
  breadcrumb?: ReactNode;
  children: ReactNode;
  email?: string | null;
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
        <Icon weight={active ? "fill" : undefined} />
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
  const { sidebarOpen } = useRouteContext({ from: "__root__" });
  const knownRole = role && role in roles ? (role as RoleName) : null;
  const canReadAudit = useCan(knownRole, "audit", "read");
  const canReadSshKey = useCan(knownRole, "sshKey", "read");
  const canReadGitProvider = useCan(knownRole, "gitProvider", "read");
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
  const initial = email ? email.charAt(0).toUpperCase() : "?";
  const gravatarUrl = useGravatarUrl(email);

  return (
    <SidebarProvider
      className="h-svh overflow-hidden"
      defaultOpen={sidebarOpen}
    >
      <a
        className="sr-only z-50 rounded-2xl bg-popover px-4 py-2 font-medium text-sm shadow-lg ring-1 ring-border focus:not-sr-only focus:fixed focus:top-3 focus:inset-s-3"
        href="#content"
      >
        Skip to content
      </a>

      <Sidebar collapsible="icon" variant="inset">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
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
                {canReadSshKey ? (
                  <NavItem
                    active={pathname.startsWith("/ssh-keys")}
                    icon={KeyIcon}
                    label="SSH keys"
                    to="/ssh-keys"
                  />
                ) : null}
                {canReadGitProvider ? (
                  <NavItem
                    active={pathname.startsWith("/git-providers")}
                    icon={GitBranchIcon}
                    label="Git providers"
                    to="/git-providers"
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
                <NavItem
                  active={pathname.startsWith("/settings")}
                  icon={GearIcon}
                  label="Settings"
                  to="/settings"
                />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuButton
                      className="group-data-[collapsible=icon]:justify-center"
                      size="lg"
                      tooltip={email ?? "Account"}
                    />
                  }
                >
                  <Avatar>
                    {gravatarUrl ? <AvatarImage src={gravatarUrl} /> : null}
                    <AvatarFallback>{initial}</AvatarFallback>
                  </Avatar>
                  <span className="truncate group-data-[collapsible=icon]:hidden">
                    {email}
                  </span>
                  <CaretUpDownIcon
                    className="ms-auto shrink-0 text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden"
                    data-icon="inline-end"
                    weight="regular"
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top">
                  {email ? (
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>{email}</DropdownMenuLabel>
                    </DropdownMenuGroup>
                  ) : null}
                  <ThemeToggle />
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={handleSignOut}
                    variant="destructive"
                  >
                    <SignOutIcon weight="regular" />
                    <span>Sign out</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="min-h-0 overflow-hidden md:peer-data-[variant=inset]:ring-1 md:peer-data-[variant=inset]:ring-border">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ms-1" size="icon" />
          {breadcrumb ? (
            <>
              <h1 className="sr-only">{title}</h1>
              {breadcrumb}
            </>
          ) : (
            <h1 className="font-medium text-sm tracking-tight">{title}</h1>
          )}
          <div className="ms-auto flex min-w-0 items-center gap-2">
            {actions}
          </div>
        </header>
        <div
          className="scroll-fade no-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto p-4"
          id="content"
        >
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
