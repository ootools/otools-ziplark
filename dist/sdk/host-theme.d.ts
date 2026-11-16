/** 宿主临时主题的覆盖值；`null` 表示恢复用户主题。 */
export type HostThemeOverride = 'light' | 'dark' | null;
export type HostThemeOptions = {
    background?: string | null;
};
export type SetTempHostTheme = (theme: HostThemeOverride, options?: HostThemeOptions) => Promise<void>;
