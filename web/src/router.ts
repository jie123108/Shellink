import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory('/shellink/ui/'),
  routes: [
    { path: '/login', component: () => import('./views/LoginView.vue') },
    { path: '/', component: () => import('./views/DashboardView.vue') },
    { path: '/profiles', component: () => import('./views/ProfilesView.vue') },
    { path: '/webhook-messages', component: () => import('./views/WebhookMessagesView.vue') },
    { path: '/sessions/:id', component: () => import('./views/SessionView.vue') },
    { path: '/sessions/:id/history', component: () => import('./views/HistoryView.vue') },
  ],
})

// Token and token-free modes are supported; non-local API 401 responses redirect to login.
