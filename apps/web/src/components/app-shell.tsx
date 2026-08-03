import {
  HardDrivesIcon,
  SignOutIcon,
  SquaresFourIcon,
} from "@phosphor-icons/react";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useCallback } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";

export interface ScopeLink {
  environment: string;
  key: string;
  project: string;
}

interface Props {
  actions?: ReactNode;
  children: ReactNode;
  email?: string | null;
  scopes?: ScopeLink[];
  title: string;
}

export function AppShell({ actions, children, email, scopes, title }: Props) {
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
    // Hauteur de viewport VERROUILLÉE, pas seulement minimale : avec la
    // variante « inset », la carte doit rester posée dans l'écran et défiler
    // par l'intérieur. Sinon c'est la page entière qui défile et la carte —
    // ses coins arrondis, son en-tête — s'en va vers le haut.
    <SidebarProvider className="h-svh overflow-hidden">
      <Sidebar collapsible="icon" variant="inset">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton render={<Link to="/" />} size="lg">
                {/* Le carré porte la marque quand la barre est réduite à ses
                    icônes : sans lui, l'en-tête disparaîtrait entièrement. */}
                <span className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-primary font-semibold text-primary-foreground text-sm">
                  N
                </span>
                <span className="font-semibold tracking-tight">Noddle</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={onDashboard}
                    render={<Link to="/" />}
                    tooltip="Déploiements"
                  >
                    <SquaresFourIcon
                      weight={onDashboard ? "fill" : "regular"}
                    />
                    <span>Déploiements</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={pathname.startsWith("/serveurs")}
                    render={<Link to="/serveurs" />}
                    tooltip="Serveurs"
                  >
                    <HardDrivesIcon
                      weight={
                        pathname.startsWith("/serveurs") ? "fill" : "regular"
                      }
                    />
                    <span>Serveurs</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {scopes && scopes.length > 0 ? (
            <SidebarGroup className="group-data-[collapsible=icon]:hidden">
              <SidebarGroupLabel>Environnements</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {scopes.map((scope) => (
                    <SidebarMenuItem key={scope.key}>
                      <SidebarMenuButton
                        render={
                          <a href={`#${scope.key}`}>
                            <span className="truncate">
                              {scope.project}
                              <span className="text-sidebar-foreground/50">
                                {" / "}
                              </span>
                              {scope.environment}
                            </span>
                          </a>
                        }
                        size="sm"
                      />
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ) : null}
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
              <SidebarMenuButton
                onClick={handleSignOut}
                tooltip="Se déconnecter"
              >
                <SignOutIcon />
                <span>Se déconnecter</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      {/* `min-h-0` : sans lui, un enfant en `flex-1` refuse de rétrécir sous
          sa hauteur de contenu et déborde au lieu de faire défiler. */}
      <SidebarInset className="min-h-0 overflow-hidden">
        {/* Collant : sur un écran qu'on parcourt, l'action de création et le
            repli de la barre doivent rester atteignables sans remonter. */}
        {/* L'en-tête ne défile pas parce qu'il est HORS du conteneur qui
            défile, pas parce qu'il serait `sticky` : rien ne peut donc passer
            dessous. */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ms-1" />
          <h1 className="font-medium text-sm tracking-tight">{title}</h1>
          <div className="ms-auto flex min-w-0 items-center gap-2">
            {actions}
          </div>
        </header>
        {/* `scroll-fade` est piloté par le défilement : le dégradé n'apparaît
            que s'il reste quelque chose à faire défiler de ce côté-là. Il
            remplace donc la barre, que `no-scrollbar` retire — sans lui, plus
            rien n'indiquerait qu'il y a une suite. */}
        <div className="scroll-fade no-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
