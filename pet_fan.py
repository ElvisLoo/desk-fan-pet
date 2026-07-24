import tkinter as tk
import math
import random


class FanWindow:
    def __init__(self, master):
        self.master = master
        self.master.title("风扇")
        self.master.geometry("500x620+120+120")
        self.master.overrideredirect(True)
        self.master.attributes('-topmost', True)

        self.TRANSPARENT_COLOR = '#010101'
        self.master.configure(bg=self.TRANSPARENT_COLOR)
        try:
            self.master.attributes('-transparentcolor', self.TRANSPARENT_COLOR)
        except Exception:
            pass

        self.canvas = tk.Canvas(master, width=500, height=620,
                                bg=self.TRANSPARENT_COLOR, highlightthickness=0)
        self.canvas.pack()

        self.is_on = False
        self.speed = 0
        self.fan_angle = 0
        self.oscillating = False
        self.osc_t = 0
        self.fan_size = 1

        self._drag_data = {"x": 0, "y": 0}
        self.canvas.bind('<ButtonPress-1>', self._start_drag)
        self.canvas.bind('<B1-Motion>', self._on_drag)

        random.seed(42)
        self.dust_angles = [random.uniform(0, 360) for _ in range(40)]
        self.dust_r = [random.uniform(0.25, 0.85) for _ in range(40)]
        self.dust_size = [random.uniform(1, 2.5) for _ in range(40)]

    def animate(self):
        if self.speed > 0:
            self.fan_angle += self.speed * 7
            if self.fan_angle >= 360:
                self.fan_angle -= 360
        if self.oscillating and self.speed > 0:
            self.osc_t += 0.035
        else:
            self.osc_t = 0
        self.draw()
        self.master.after(40, self.animate)

    def _start_drag(self, event):
        self._drag_data["x"] = event.x_root
        self._drag_data["y"] = event.y_root

    def _on_drag(self, event):
        dx = event.x_root - self._drag_data["x"]
        dy = event.y_root - self._drag_data["y"]
        self.master.geometry(f"+{self.master.winfo_x()+dx}+{self.master.winfo_y()+dy}")
        self._drag_data["x"] = event.x_root
        self._drag_data["y"] = event.y_root

    def _cpts(self, cx, cy, r, n=96):
        pts = []
        for i in range(n):
            a = 2 * math.pi * i / n
            pts.extend([cx + r * math.cos(a), cy + r * math.sin(a)])
        return pts

    def _epts(self, cx, cy, rx, ry, n=96):
        pts = []
        for i in range(n):
            a = 2 * math.pi * i / n
            pts.extend([cx + rx * math.cos(a), cy + ry * math.sin(a)])
        return pts

    def draw(self):
        self.canvas.delete("all")
        W, H = 500, 620
        cx = W // 2

        sizes = [(120, 620), (150, 620), (180, 620)]
        fan_r, _ = sizes[self.fan_size]

        base_bottom = H - 22
        base_h = 110
        base_top = base_bottom - base_h
        bw_top = 46
        bw_bot = 82

        pivot_x = cx
        pivot_y = base_top + 8
        head_cy = pivot_y - fan_r - 12

        if self.oscillating and self.speed > 0:
            tilt = math.sin(self.osc_t) * 22
        else:
            self.osc_t = 0
            tilt = 0

        # 预计算旋转后的扇头中心
        rad = math.radians(tilt)
        c, s = math.cos(rad), math.sin(rad)
        dx = cx - pivot_x
        dy = head_cy - pivot_y
        head_cx = pivot_x + dx * c - dy * s
        head_cy_rot = pivot_y + dx * s + dy * c

        # ===== 底座阴影 =====
        for i in range(6):
            t = i / 5
            shade = int(200 + t * 30)
            color = f"#{shade:02x}{shade:02x}{shade:02x}"
            self.canvas.create_polygon(
                self._epts(cx, base_bottom + 3, bw_bot + 14 - int(t*5), 10 - int(t*2)),
                fill=color, outline="")

        # 底部椭圆
        self.canvas.create_polygon(self._epts(cx, base_bottom, bw_bot + 2, 12),
                                   fill="#e2e2e2", outline="#d5d5d5", width=1)

        # 锥体
        cone_h = base_bottom - 6 - base_top
        for i in range(5):
            t = i / 4
            y1 = base_top + int(t * cone_h)
            y2 = base_top + int((t + 0.25) * cone_h)
            if t + 0.25 > 1:
                y2 = base_bottom - 6
            w1 = bw_top + int(t * (bw_bot - bw_top))
            w2 = bw_top + int((t + 0.25) * (bw_bot - bw_top))
            shade = int(245 - t * 12)
            color = f"#{shade:02x}{shade:02x}{shade:02x}"
            self.canvas.create_polygon(
                [cx - w1, y1, cx + w1, y1, cx + w2, y2, cx - w2, y2],
                fill=color, outline="")
        self.canvas.create_polygon(
            [cx - bw_top, base_top, cx + bw_top, base_top,
             cx + bw_bot, base_bottom - 6, cx - bw_bot, base_bottom - 6],
            fill="", outline="#e2e2e2", width=1)

        # 顶部椭圆
        self.canvas.create_polygon(self._epts(cx, base_top + 2, bw_top, 10),
                                   fill="#f5f5f5", outline="#eaeaea", width=1)

        # === 橙色旋钮 ===
        btn_y = base_top + int(base_h * 0.52)
        self.canvas.create_polygon(self._cpts(cx, btn_y, 13, 64),
                                   fill="#FF6A00", outline="#E05500", width=1)
        self.canvas.create_polygon(self._cpts(cx, btn_y, 7, 32),
                                   fill="#FF8833", outline="")
        self.canvas.create_polygon(self._cpts(cx - 3, btn_y - 3, 3, 16),
                                   fill="#FFAA66", outline="")

        # === 4颗橙色指示灯 ===
        dot_y = btn_y - 30
        for i in range(4):
            dx = cx - 16 + i * 11
            if i < self.speed:
                self.canvas.create_polygon(self._cpts(dx, dot_y, 4, 32),
                                           fill="#FF6A00", outline="#E05500", width=1)
                self.canvas.create_polygon(self._cpts(dx, dot_y, 2, 16),
                                           fill="#FFB366", outline="")
            else:
                self.canvas.create_polygon(self._cpts(dx, dot_y, 4, 32),
                                           fill="#d5d5d5", outline="#c0c0c0", width=1)

        # ===== 连接杆 =====
        neck_top = base_top + 2
        head_bottom = head_cy_rot + fan_r + 6
        nw_bot = 14
        nw_top = 6
        self.canvas.create_polygon(
            [cx - nw_bot, neck_top, cx + nw_bot, neck_top,
             head_cx + nw_top, head_bottom, head_cx - nw_top, head_bottom],
            fill="#ececec", outline="#ddd", width=1)

        # ===== 扇头 =====
        self._draw_head(head_cx, head_cy_rot, fan_r)

    def _draw_head(self, cx, cy, fan_r):

        # 网罩外圈
        self.canvas.create_polygon(self._cpts(cx, cy, fan_r + 6, 96),
                                   fill="#f6f6f6", outline="#e4e4e4", width=4)
        self.canvas.create_polygon(self._cpts(cx, cy, fan_r + 1, 96),
                                   fill="#f1f1f1", outline="#dedede", width=2)

        # 扇叶
        blade_len = fan_r - 20
        rot = self.fan_angle if self.speed > 0 else 0
        for i in range(7):
            base_a = math.radians(rot + i * (360 / 7))
            pts = []
            for da in range(-22, 23, 2):
                a = base_a + math.radians(da)
                pts.extend([cx + blade_len * math.cos(a), cy + blade_len * math.sin(a)])
            for da in range(22, -23, -2):
                a = base_a + math.radians(da)
                pts.extend([cx + 14 * math.cos(a), cy + 14 * math.sin(a)])
            if len(pts) >= 6:
                self.canvas.create_polygon(pts, fill="#b0d4f1", outline="#90b8d9", width=1, smooth=False)

        # 放射状网罩线
        for deg in range(0, 360, 8):
            rad = math.radians(deg)
            r_in, r_out = 26, fan_r - 3
            x1 = cx + r_in * math.cos(rad)
            y1 = cy + r_in * math.sin(rad)
            x2 = cx + r_out * math.cos(rad)
            y2 = cy + r_out * math.sin(rad)
            self.canvas.create_line(x1, y1, x2, y2, fill="#f5f5f5", width=4, capstyle="round")

        # 同心加固线
        for ratio in [0.35, 0.58, 0.8]:
            r = int(fan_r * ratio)
            self.canvas.create_polygon(self._cpts(cx, cy, r, 96),
                                       fill="", outline="#ececec", width=1)

        # 中心圆
        self.canvas.create_polygon(self._cpts(cx, cy, 20, 96),
                                   fill="#f4f4f4", outline="#ddd", width=1)
        self.canvas.create_polygon(self._cpts(cx, cy, 12, 96),
                                   fill="#f0f0f0", outline="#ddd", width=1)

        # MI文字
        self.canvas.create_text(cx, cy, text="MI", font=("Arial", 11, "bold"), fill="#ccc")

        # 灰尘
        for i in range(len(self.dust_angles)):
            a = self.dust_angles[i]
            r = self.dust_r[i] * fan_r * 0.85
            if self.speed > 0:
                dust_angle = math.radians(a + self.fan_angle * 0.3)
            else:
                dust_angle = math.radians(a)
            dx = cx + r * math.cos(dust_angle)
            dy = cy + r * math.sin(dust_angle)
            sz = self.dust_size[i]
            shade = int(195 + self.dust_r[i] * 30)
            color = f"#{shade:02x}{shade:02x}{shade:02x}"
            self.canvas.create_oval(dx - sz, dy - sz, dx + sz, dy + sz,
                                    fill=color, outline="")


class RemoteWindow:
    def __init__(self, master, fan):
        self.master = master
        self.fan = fan
        self.master.title("")
        self.master.overrideredirect(True)
        self.master.geometry("300x520+640+120")
        self.master.configure(bg="#f0f0f0")

        self.W, self.H = 300, 520
        self.canvas = tk.Canvas(master, width=self.W, height=self.H,
                                bg="#f0f0f0", highlightthickness=0)
        self.canvas.pack()

        self.btn_rects = {}
        self.selected = {"osc": 0, "size": 1, "pin": 1}
        self.power_on = False
        self.speed_val = 0
        self.slider_dragging = False

        self.canvas.bind('<ButtonPress-1>', self.on_click)
        self.canvas.bind('<B1-Motion>', self.on_drag)
        self.canvas.bind('<ButtonRelease-1>', self.on_release)
        self._drag_data = {"x": 0, "y": 0}

        self.draw_remote()

    def draw_remote(self):
        self.canvas.delete("all")
        W, H = self.W, self.H
        pad = 20

        self._rrect(2, 2, W-2, H-2, 18, fill="#ffffff", outline="#e8e8e8", width=1)

        self.canvas.create_text(W//2, 30, text="遥控器",
                                font=("Microsoft YaHei", 16, "bold"), fill="#333")

        y = 54
        bh = 48
        color = "#4CAF50" if self.power_on else "#c8c8c8"
        text = "已开机" if self.power_on else "已关机"
        self._rrect(pad, y, W-pad, y+bh, 12, fill=color, outline="")
        self.canvas.create_text(W//2, y+bh//2, text="⊙ "+text,
                                font=("Microsoft YaHei", 14, "bold"), fill="#fff")
        self.btn_rects["power"] = (pad, y, W-pad, y+bh)

        y += bh + 18
        self.canvas.create_text(W//2, y, text="风速", font=("Microsoft YaHei", 11), fill="#999")
        y += 22
        sx1, sx2 = pad + 10, W - pad - 10
        sy = y + 18
        sw = sx2 - sx1

        self._rrect(sx1, sy-4, sx2, sy+4, 4, fill="#e0e0e0", outline="")
        fw = int(sw * self.speed_val / 4)
        if fw > 0:
            self._rrect(sx1, sy-4, sx1+fw, sy+4, 4, fill="#FF6A00", outline="")

        knob_x = sx1 + fw
        self.canvas.create_polygon(self._cpts(knob_x, sy, 10, 48),
                                   fill="#FF6A00", outline="#E05500", width=1)
        self.canvas.create_polygon(self._cpts(knob_x, sy, 4, 24),
                                   fill="#FF8833", outline="")

        labels = {0: "关", 1: "1档", 2: "2档", 3: "3档", 4: "4档"}
        self.canvas.create_text(W//2, sy+22, text=labels[self.speed_val],
                                font=("Microsoft YaHei", 11, "bold"), fill="#333")

        self.slider_rect = (sx1-10, sy-18, sx2+10, sy+18)
        self.slider_x1, self.slider_x2, self.slider_y = sx1, sx2, sy

        y = sy + 42

        y += 4
        self.canvas.create_text(W//2, y, text="摇头", font=("Microsoft YaHei", 11), fill="#999")
        y += 22
        self._draw_row(["关", "开"], "osc", pad, y, W)
        y += 44

        y += 4
        self.canvas.create_text(W//2, y, text="大小", font=("Microsoft YaHei", 11), fill="#999")
        y += 22
        self._draw_row(["小", "中", "大"], "size", pad, y, W)
        y += 44

        y += 4
        self.canvas.create_text(W//2, y, text="窗口置顶", font=("Microsoft YaHei", 11), fill="#999")
        y += 22
        self._draw_row(["取消", "置顶"], "pin", pad, y, W)
        y += 44

        y += 10
        self._rrect(pad, y, W-pad, y+44, 12, fill="#f44336", outline="")
        self.canvas.create_text(W//2, y+22, text="退出程序",
                                font=("Microsoft YaHei", 12, "bold"), fill="#fff")
        self.btn_rects["quit"] = (pad, y, W-pad, y+44)

    def _rrect(self, x1, y1, x2, y2, r, **kw):
        pts = [x1+r,y1, x2-r,y1, x2,y1, x2,y1+r,
               x2,y2-r, x2,y2, x2-r,y2, x1+r,y2,
               x1,y2, x1,y2-r, x1,y1+r, x1,y1]
        return self.canvas.create_polygon(pts, smooth=True, **kw)

    def _cpts(self, cx, cy, r, n=48):
        pts = []
        for i in range(n):
            a = 2*math.pi*i/n
            pts.extend([cx+r*math.cos(a), cy+r*math.sin(a)])
        return pts

    def _draw_row(self, labels, group, pad, y, W):
        n = len(labels)
        gap = 10
        bw = (W - pad*2 - gap*(n-1)) // n
        bh = 38
        self.btn_rects[group] = []
        for i, label in enumerate(labels):
            x1 = pad + i*(bw+gap)
            x2 = x1 + bw
            sel = (self.selected[group] == i)
            color = "#2196F3" if sel else "#f5f5f5"
            tc = "#fff" if sel else "#555"
            ol = "#2196F3" if sel else "#e0e0e0"
            self._rrect(x1, y, x2, y+bh, 8, fill=color, outline=ol, width=1)
            self.canvas.create_text((x1+x2)//2, y+bh//2, text=label,
                                    font=("Microsoft YaHei", 11), fill=tc)
            self.btn_rects[group].append((x1, y, x2, y+bh))

    def on_click(self, event):
        x, y = event.x, event.y
        self._drag_data = {"x": event.x_root, "y": event.y_root}

        if self._hit("quit", x, y):
            self.master.destroy()
            self.fan.master.destroy()
            return
        if self._hit("power", x, y):
            self.power_on = not self.power_on
            if self.power_on and self.fan.speed == 0:
                self.fan.speed = 1
                self.speed_val = 1
            elif not self.power_on:
                self.fan.speed = 0
                self.speed_val = 0
            self.draw_remote()
            return

        sx1, sy1, sx2, sy2 = self.slider_rect
        if sx1 <= x <= sx2 and sy1 <= y <= sy2:
            self.slider_dragging = True
            self._update_slider(x)
            return

        for group in ["osc", "size", "pin"]:
            for i, rect in enumerate(self.btn_rects.get(group, [])):
                if self._in_rect(x, y, rect):
                    self.selected[group] = i
                    self._apply(group, i)
                    self.draw_remote()
                    return

    def _update_slider(self, x):
        ratio = max(0, min(1, (x - self.slider_x1) / (self.slider_x2 - self.slider_x1)))
        self.speed_val = round(ratio * 4)
        self.fan.speed = self.speed_val if self.power_on else 0
        self.draw_remote()

    def _hit(self, key, x, y):
        r = self.btn_rects.get(key)
        return r and self._in_rect(x, y, r)

    def _in_rect(self, x, y, r):
        return r[0] <= x <= r[2] and r[1] <= y <= r[3]

    def _apply(self, group, val):
        if group == "osc":
            self.fan.oscillating = (val == 1)
        elif group == "size":
            self.fan.fan_size = val
        elif group == "pin":
            on = (val == 1)
            self.fan.master.attributes('-topmost', on)

    def on_drag(self, event):
        dx = event.x_root - self._drag_data["x"]
        dy = event.y_root - self._drag_data["y"]
        self.master.geometry(f"+{self.master.winfo_x()+dx}+{self.master.winfo_y()+dy}")
        self._drag_data["x"] = event.x_root
        self._drag_data["y"] = event.y_root
        if self.slider_dragging:
            self._update_slider(event.x)

    def on_release(self, event):
        self.slider_dragging = False


class DeskFanApp:
    def __init__(self):
        self.root = tk.Tk()
        self.root.withdraw()
        self.fan_win = FanWindow(tk.Toplevel(self.root))
        self.remote_win = RemoteWindow(tk.Toplevel(self.root), self.fan_win)
        self.remote_win.master.protocol("WM_DELETE_WINDOW", self.quit)
        self.fan_win.master.protocol("WM_DELETE_WINDOW", self.quit)
        self.fan_win.animate()
        self.root.mainloop()

    def quit(self):
        self.root.destroy()


if __name__ == "__main__":
    DeskFanApp()
