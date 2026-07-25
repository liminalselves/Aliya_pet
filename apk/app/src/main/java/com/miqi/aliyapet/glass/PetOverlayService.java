package com.miqi.aliyapet.glass;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.AnimatorSet;
import android.animation.ObjectAnimator;
import android.animation.PropertyValuesHolder;
import android.animation.ValueAnimator;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.animation.AccelerateDecelerateInterpolator;
import android.view.animation.BounceInterpolator;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;

import java.util.Random;

public class PetOverlayService extends Service {
    public static final String ACTION_START = "com.miqi.aliyapet.glass.action.START";
    public static final String ACTION_STOP = "com.miqi.aliyapet.glass.action.STOP";
    public static final String ACTION_RANDOM = "com.miqi.aliyapet.glass.action.RANDOM";
    public static final String ACTION_RESET = "com.miqi.aliyapet.glass.action.RESET";
    public static final String ACTION_TOGGLE_AUTO = "com.miqi.aliyapet.glass.action.TOGGLE_AUTO";
    public static final String ACTION_TOGGLE_MIRROR = "com.miqi.aliyapet.glass.action.TOGGLE_MIRROR";
    public static final String ACTION_SET_CHARACTER = "com.miqi.aliyapet.glass.action.SET_CHARACTER";
    public static final String CHARACTER_ALIYA = "Aliya";
    public static final String CHARACTER_WINDY = "Windy";

    private static final String CHANNEL_ID = "aliya_pet_channel";
    private static final String PREFS = "aliya_pet_settings";
    private static final int NOTIFICATION_ID = 7;
    private static final int BLINK_FRAME_COUNT = 3;
    private static final int BLINK_FRAME_DURATION_MS = 50;
    private static volatile boolean running;

    private static final int[] WINDOW_WIDTHS = {354, 436, 554};
    private static final int[] WINDOW_BOTTOM_PADDINGS = {30, 35, 45};
    private static final int[] PET_WIDTHS = {210, 260, 330};
    private static final int[] PET_HEIGHTS = {330, 410, 520};

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Random random = new Random();

    private WindowManager windowManager;
    private FrameLayout overlay;
    private ImageView pet;
    private TextView bubble;
    private WindowManager.LayoutParams params;
    private FrameLayout.LayoutParams petLayoutParams;
    private SharedPreferences preferences;
    private Animator currentAnimator;

    private boolean actionRunning;
    private boolean dragging;
    private boolean moved;
    private boolean autoActions = true;
    private boolean mirrored;
    private int blinkFramesRemaining;
    private int petTopMargin;
    private String character = CHARACTER_ALIYA;
    private int sizeIndex = 1;
    private long lastTapTime;

    private float downRawX;
    private float downRawY;
    private long downTime;
    private float lastRawX;
    private float lastRawY;

    private final String[] generalPhrases = {
            "今天也要认真工作呀。",
            "COSMOS 正在待命。",
            "要记得休息一下。",
            "我会一直陪着你。",
            "点击我会做随机动作。",
            "双击可以改变大小。",
            "拖动后我会贴近屏幕边缘。",
            "桌面宠物已连接。",
            "任务完成后也要休息一下。",
            "要不要一起发会儿呆？"
    };

    private final String[] aliyaPhrases = {
            "当我们都在仰望星空时，我可能正在注视你的眼睛。",
            "哼哼，今天也被我发现你在发呆了。",
            "啊，那边的烟花怎么突然放了？",
            "开心点嘛，我现在不是还在这里吗？",
            "喂，别不理我啊……不理我算了。骗你的。",
            "呜啊，又是新的一天。我昨晚好像又熬夜了。",
            "哈哈哈，这样的说法好酷哦。",
            "我正在宇宙大爆炸的余晖中起舞。",
            "原来你还是个爱哭鬼啊。拍照给我？开玩笑的。",
            "你那里是2025年吧？真想看看一千年前的星空。",
            "一千年和一千光年，都没能挡住这次连接。",
            "3025年的今天，也要认真工作呀。",
            "我24岁了，可宇宙还是有太多没见过的东西。",
            "COSMOS，下一段航线也拜托你了。",
            "海獭号今天状态不错，可以继续航行。",
            "研究员也会偷飞船的……特殊情况嘛。",
            "机械工程师证可不是摆设，飞船交给我吧。",
            "研究生物很有趣，每个生命都在认真活着。",
            "如果发现新物种，命名权可以分你一半。",
            "兔子狗真的很可爱，这一点不接受反驳。",
            "风信子的花语，会不会也传得到一千光年外？",
            "未知不是用来害怕的，是用来靠近的。",
            "我会找到父亲留下的答案，无论航线有多远。",
            "有些信，要跨过很久以后才能真正读懂。",
            "Ryoko看到我熬夜，肯定又要念我了。",
            "Kane嘴上不说，修船时倒是很可靠。",
            "先冷静……呜啊，等一下，我马上就能处理好！",
            "我没有慌，只是在快速整理思路。真的。",
            "外表冷静只是习惯，害怕时也要继续前进。",
            "Doll也好，克隆体也好，我就是Aliya。",
            "如果回忆属于过去，选择至少属于现在的我。",
            "第17次醒来时，我还不知道会遇见你。",
            "时间可以回溯，但每一次相遇都是真的。",
            "笑容不是忘记过去，是决定继续向前。",
            "如果命运又要重来，我还是想亲自选择方向。",
            "地球时间该睡了？再探索一小会儿嘛。",
            "自由扮演类游戏最好玩，因为下一步由自己决定。",
            "甜妹也会修飞船，别小看我哦。",
            "宇宙这么大，我们能相识已经很不可思议了。",
            "今天探索什么？新星球，还是你的心事？"
    };

    private final Runnable hideBubble = this::hideBubble;

    private final Runnable singleTap = () -> {
        if (pet == null) {
            return;
        }
        showRandomPhrase();
        playRandomAction();
    };

    private final Runnable openEyes = new Runnable() {
        @Override
        public void run() {
            if (pet == null) {
                return;
            }

            blinkFramesRemaining--;
            if (blinkFramesRemaining > 0) {
                pet.setImageResource(blinkImageResource());
                handler.postDelayed(this, BLINK_FRAME_DURATION_MS);
            } else {
                pet.setImageResource(openImageResource());
            }
        }
    };

    private final Runnable blink = new Runnable() {
        @Override
        public void run() {
            if (!dragging && pet != null) {
                pet.setImageResource(blinkImageResource());
                blinkFramesRemaining = BLINK_FRAME_COUNT;
                handler.removeCallbacks(openEyes);
                handler.postDelayed(openEyes, BLINK_FRAME_DURATION_MS);
            }
            scheduleBlink();
        }
    };

    private final Runnable autoAction = new Runnable() {
        @Override
        public void run() {
            if (autoActions && !dragging && !actionRunning && pet != null) {
                playRandomAction();
            }
            scheduleAutoAction();
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        createChannel();
        startForeground(NOTIFICATION_ID, createNotification());

        preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        autoActions = preferences.getBoolean("auto_actions", true);
        mirrored = preferences.getBoolean("mirrored", false);
        character = normalizeCharacter(preferences.getString("character", CHARACTER_ALIYA));
        sizeIndex = clamp(preferences.getInt("size_index", 1), 0, WINDOW_WIDTHS.length - 1);
        petTopMargin = dp(4);

        if (!Settings.canDrawOverlays(this)) {
            stopSelf();
            return;
        }

        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        createOverlay();
        scheduleBlink();
        scheduleAutoAction();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (action == null) {
            action = ACTION_START;
        }

        switch (action) {
            case ACTION_STOP:
                stopSelf();
                break;
            case ACTION_RANDOM:
                handler.postDelayed(() -> {
                    showRandomPhrase();
                    playRandomAction();
                }, 120);
                break;
            case ACTION_RESET:
                handler.postDelayed(this::resetPosition, 120);
                break;
            case ACTION_TOGGLE_AUTO:
                autoActions = !autoActions;
                preferences.edit().putBoolean("auto_actions", autoActions).apply();
                showBubble(autoActions ? "自动动作已开启。" : "自动动作已关闭。");
                scheduleAutoAction();
                break;
            case ACTION_TOGGLE_MIRROR:
                mirrored = !mirrored;
                applyMirror();
                preferences.edit().putBoolean("mirrored", mirrored).apply();
                showBubble(mirrored ? "角色已镜像。" : "角色已恢复方向。");
                break;
            case ACTION_SET_CHARACTER:
                character = normalizeCharacter(
                        preferences.getString("character", CHARACTER_ALIYA));
                handler.removeCallbacks(openEyes);
                if (pet != null) {
                    pet.setImageResource(openImageResource());
                    showBubble("已切换为 " + character + "。");
                }
                break;
            default:
                break;
        }

        return START_STICKY;
    }

    private Notification createNotification() {
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent openPendingIntent = PendingIntent.getActivity(
                this,
                10,
                openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent actionIntent = new Intent(this, PetOverlayService.class);
        actionIntent.setAction(ACTION_RANDOM);
        PendingIntent actionPendingIntent = PendingIntent.getService(
                this,
                11,
                actionIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent stopIntent = new Intent(this, PetOverlayService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPendingIntent = PendingIntent.getService(
                this,
                12,
                stopIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        return new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("桌面宠物运行中")
                .setContentText("点击宠物互动，双击缩放，拖动可移动")
                .setSmallIcon(android.R.drawable.star_on)
                .setContentIntent(openPendingIntent)
                .addAction(android.R.drawable.ic_media_play, "随机动作", actionPendingIntent)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "停止", stopPendingIntent)
                .setOngoing(true)
                .build();
    }

    private void createOverlay() {
        overlay = new FrameLayout(this);
        overlay.setClipChildren(false);
        overlay.setClipToPadding(false);

        pet = new ImageView(this);
        pet.setImageResource(openImageResource());
        pet.setAdjustViewBounds(true);
        pet.setScaleType(ImageView.ScaleType.FIT_CENTER);
        pet.setPivotX(PET_WIDTHS[sizeIndex] / 2f);
        pet.setPivotY(PET_HEIGHTS[sizeIndex]);
        applyMirror();

        bubble = new TextView(this);
        bubble.setTextSize(14);
        bubble.setTextColor(Color.rgb(51, 40, 58));
        bubble.setPadding(20, 12, 20, 12);
        bubble.setGravity(Gravity.CENTER);
        bubble.setMaxLines(3);
        bubble.setMaxWidth(WINDOW_WIDTHS[sizeIndex] - 12);
        bubble.setElevation(8f);
        bubble.setBackground(createBubbleBackground());
        bubble.setVisibility(View.GONE);

        petLayoutParams = new FrameLayout.LayoutParams(
                PET_WIDTHS[sizeIndex],
                PET_HEIGHTS[sizeIndex]);
        petLayoutParams.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        petLayoutParams.topMargin = petTopMargin();
        overlay.addView(pet, petLayoutParams);

        FrameLayout.LayoutParams bubbleParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        bubbleParams.leftMargin = 6;
        bubbleParams.rightMargin = 6;
        overlay.addView(bubble, bubbleParams);

        params = new WindowManager.LayoutParams(
                WINDOW_WIDTHS[sizeIndex],
                windowHeight(),
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = preferences.getInt("x", defaultX());
        params.y = preferences.getInt("y", defaultY());
        clampPosition();

        pet.setOnTouchListener(this::handleTouch);
        windowManager.addView(overlay, params);
    }

    private GradientDrawable createBubbleBackground() {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(0xF2FFFFFF);
        drawable.setCornerRadius(22f);
        drawable.setStroke(1, 0x5533283A);
        return drawable;
    }

    private boolean handleTouch(View view, MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                cancelCurrentAction();
                handler.removeCallbacks(singleTap);
                handler.removeCallbacks(openEyes);
                pet.setImageResource(openImageResource());
                dragging = true;
                moved = false;
                downRawX = event.getRawX();
                downRawY = event.getRawY();
                lastRawX = downRawX;
                lastRawY = downRawY;
                downTime = System.currentTimeMillis();
                pet.animate().scaleY(1.02f).setDuration(90).start();
                return true;

            case MotionEvent.ACTION_MOVE:
                float dx = event.getRawX() - downRawX;
                float dy = event.getRawY() - downRawY;
                if (Math.abs(dx) > 16 || Math.abs(dy) > 16) {
                    moved = true;
                }

                float frameDx = event.getRawX() - lastRawX;
                float frameDy = event.getRawY() - lastRawY;
                params.x += Math.round(frameDx);
                params.y += Math.round(frameDy);
                clampPosition();
                updateOverlayLayout();

                pet.setRotation(clamp(frameDx * 1.5f, -12f, 12f));
                lastRawX = event.getRawX();
                lastRawY = event.getRawY();
                return true;

            case MotionEvent.ACTION_UP:
                dragging = false;
                pet.animate().rotation(0f).scaleY(1f).setDuration(130).start();
                long held = System.currentTimeMillis() - downTime;

                if (!moved && held >= 1200) {
                    showBubble(character + " 已关闭。");
                    handler.postDelayed(this::stopSelf, 180);
                } else if (moved) {
                    snapToNearestEdge();
                } else {
                    handleTap();
                }
                return true;

            case MotionEvent.ACTION_CANCEL:
                dragging = false;
                pet.animate().rotation(0f).scaleY(1f).setDuration(130).start();
                scheduleAutoAction();
                return true;

            default:
                return false;
        }
    }

    private void handleTap() {
        long now = System.currentTimeMillis();
        if (now - lastTapTime <= 320) {
            handler.removeCallbacks(singleTap);
            lastTapTime = 0;
            cycleSize();
        } else {
            lastTapTime = now;
            handler.postDelayed(singleTap, 330);
        }
    }

    private void cycleSize() {
        sizeIndex = (sizeIndex + 1) % WINDOW_WIDTHS.length;
        applySize();
        String[] labels = {"小尺寸", "标准尺寸", "大尺寸"};
        showBubble("已切换为" + labels[sizeIndex] + "。");
    }

    private void applySize() {
        int oldBottom = params.y + params.height;
        params.width = WINDOW_WIDTHS[sizeIndex];
        params.height = windowHeight();
        params.y = oldBottom - params.height;

        petLayoutParams.width = PET_WIDTHS[sizeIndex];
        petLayoutParams.height = PET_HEIGHTS[sizeIndex];
        petLayoutParams.topMargin = petTopMargin();
        pet.setLayoutParams(petLayoutParams);
        bubble.setMaxWidth(WINDOW_WIDTHS[sizeIndex] - 12);
        pet.setPivotX(PET_WIDTHS[sizeIndex] / 2f);
        pet.setPivotY(PET_HEIGHTS[sizeIndex]);

        clampPosition();
        updateOverlayLayout();
        saveSettings();
    }

    private void playRandomAction() {
        playAction(random.nextInt(6));
    }

    private void playAction(int type) {
        if (pet == null || dragging || actionRunning) {
            return;
        }

        handler.removeCallbacks(autoAction);
        resetPetTransform();
        actionRunning = true;

        Animator animator;
        switch (type) {
            case 0:
                animator = createHopAnimator();
                break;
            case 1:
                animator = createSwayAnimator();
                break;
            case 2:
                animator = createShakeAnimator();
                break;
            case 3:
                animator = createStretchAnimator();
                break;
            case 4:
                animator = createNodAnimator();
                break;
            default:
                animator = createWalkAnimator();
                break;
        }

        currentAnimator = animator;
        animator.addListener(new AnimatorListenerAdapter() {
            @Override
            public void onAnimationEnd(Animator animation) {
                finishAction(animation);
            }

            @Override
            public void onAnimationCancel(Animator animation) {
                finishAction(animation);
            }
        });
        animator.start();
    }

    private Animator createHopAnimator() {
        float baseX = baseScaleX();
        PropertyValuesHolder y = PropertyValuesHolder.ofFloat(
                View.TRANSLATION_Y, 0f, -48f, 0f);
        PropertyValuesHolder sx = PropertyValuesHolder.ofFloat(
                View.SCALE_X, baseX, baseX * 1.08f, baseX);
        PropertyValuesHolder sy = PropertyValuesHolder.ofFloat(
                View.SCALE_Y, 0.94f, 1.06f, 0.96f, 1f);
        ObjectAnimator animator = ObjectAnimator.ofPropertyValuesHolder(pet, y, sx, sy);
        animator.setDuration(650);
        animator.setInterpolator(new BounceInterpolator());
        return animator;
    }

    private Animator createSwayAnimator() {
        PropertyValuesHolder rotation = PropertyValuesHolder.ofFloat(
                View.ROTATION, 0f, -7f, 7f, -6f, 6f, 0f);
        PropertyValuesHolder x = PropertyValuesHolder.ofFloat(
                View.TRANSLATION_X, 0f, -7f, 7f, -6f, 6f, 0f);
        ObjectAnimator animator = ObjectAnimator.ofPropertyValuesHolder(pet, rotation, x);
        animator.setDuration(900);
        animator.setInterpolator(new AccelerateDecelerateInterpolator());
        return animator;
    }

    private Animator createShakeAnimator() {
        PropertyValuesHolder x = PropertyValuesHolder.ofFloat(
                View.TRANSLATION_X, 0f, 9f, -9f, 8f, -8f, 6f, -6f, 0f);
        ObjectAnimator animator = ObjectAnimator.ofPropertyValuesHolder(pet, x);
        animator.setDuration(520);
        return animator;
    }

    private Animator createStretchAnimator() {
        float baseX = baseScaleX();
        PropertyValuesHolder sx = PropertyValuesHolder.ofFloat(
                View.SCALE_X, baseX, baseX * 0.90f, baseX);
        PropertyValuesHolder sy = PropertyValuesHolder.ofFloat(
                View.SCALE_Y, 1f, 1.10f, 1f);
        PropertyValuesHolder y = PropertyValuesHolder.ofFloat(
                View.TRANSLATION_Y, 0f, -9f, 0f);
        ObjectAnimator animator = ObjectAnimator.ofPropertyValuesHolder(pet, sx, sy, y);
        animator.setDuration(760);
        animator.setInterpolator(new DecelerateInterpolator());
        return animator;
    }

    private Animator createNodAnimator() {
        PropertyValuesHolder sy = PropertyValuesHolder.ofFloat(
                View.SCALE_Y, 1f, 0.94f, 1f, 0.94f, 1f);
        PropertyValuesHolder y = PropertyValuesHolder.ofFloat(
                View.TRANSLATION_Y, 0f, 10f, 0f, 10f, 0f);
        PropertyValuesHolder rotation = PropertyValuesHolder.ofFloat(
                View.ROTATION, 0f, -2f, 0f, -2f, 0f);
        ObjectAnimator animator = ObjectAnimator.ofPropertyValuesHolder(pet, sy, y, rotation);
        animator.setDuration(620);
        return animator;
    }

    private Animator createWalkAnimator() {
        int availableLeft = params.x - minX();
        int availableRight = maxX() - params.x;
        int direction = (availableRight >= 80 || availableRight >= availableLeft) ? 1 : -1;
        int distance = Math.min(140, direction > 0 ? availableRight : availableLeft);

        if (distance < 25) {
            return createHopAnimator();
        }

        int startX = params.x;
        int targetX = startX + direction * distance;

        ValueAnimator move = ValueAnimator.ofInt(startX, targetX);
        move.setDuration(950);
        move.setInterpolator(new AccelerateDecelerateInterpolator());
        move.addUpdateListener(animation -> {
            params.x = (int) animation.getAnimatedValue();
            updateOverlayLayout();
        });

        PropertyValuesHolder bob = PropertyValuesHolder.ofFloat(
                View.TRANSLATION_Y, 0f, -8f, 0f, -8f, 0f, -8f, 0f, -8f, 0f);
        PropertyValuesHolder tilt = PropertyValuesHolder.ofFloat(
                View.ROTATION, 0f, direction * 2f, 0f, -direction * 2f, 0f);
        ObjectAnimator body = ObjectAnimator.ofPropertyValuesHolder(pet, bob, tilt);
        body.setDuration(950);

        AnimatorSet set = new AnimatorSet();
        set.playTogether(move, body);
        return set;
    }

    private void finishAction(Animator animator) {
        if (animator != currentAnimator) {
            return;
        }
        currentAnimator = null;
        actionRunning = false;
        resetPetTransform();
        saveSettings();
        scheduleAutoAction();
    }

    private void cancelCurrentAction() {
        handler.removeCallbacks(autoAction);
        Animator animator = currentAnimator;
        currentAnimator = null;
        actionRunning = false;
        if (animator != null) {
            animator.removeAllListeners();
            animator.cancel();
        }
        resetPetTransform();
    }

    private void resetPetTransform() {
        if (pet == null) {
            return;
        }
        pet.animate().cancel();
        pet.setTranslationX(0f);
        pet.setTranslationY(0f);
        pet.setRotation(0f);
        pet.setScaleX(baseScaleX());
        pet.setScaleY(1f);
    }

    private void applyMirror() {
        if (pet != null) {
            pet.setScaleX(baseScaleX());
        }
    }

    private float baseScaleX() {
        return mirrored ? -1f : 1f;
    }

    private void snapToNearestEdge() {
        cancelCurrentAction();
        clampPosition();
        int startX = params.x;
        int windowCenterX = params.x + params.width / 2;
        int targetX = windowCenterX < screenWidth() / 2 ? minX() : maxX();

        ValueAnimator snap = ValueAnimator.ofInt(startX, targetX);
        currentAnimator = snap;
        actionRunning = true;
        snap.setDuration(220);
        snap.setInterpolator(new DecelerateInterpolator());
        snap.addUpdateListener(animation -> {
            params.x = (int) animation.getAnimatedValue();
            updateOverlayLayout();
        });
        snap.addListener(new AnimatorListenerAdapter() {
            @Override
            public void onAnimationEnd(Animator animation) {
                params.x = targetX;
                updateOverlayLayout();
                finishAction(animation);
            }

            @Override
            public void onAnimationCancel(Animator animation) {
                finishAction(animation);
            }
        });
        snap.start();
    }

    private void resetPosition() {
        if (params == null) {
            return;
        }
        cancelCurrentAction();
        params.x = defaultX();
        params.y = defaultY();
        clampPosition();
        updateOverlayLayout();
        saveSettings();
        showBubble("已回到右下角。");
        scheduleAutoAction();
    }

    private void showRandomPhrase() {
        String[] phrases = CHARACTER_ALIYA.equals(character)
                ? aliyaPhrases
                : generalPhrases;
        showBubble(phrases[random.nextInt(phrases.length)]);
    }

    private void showBubble(String text) {
        if (bubble == null) {
            return;
        }
        bubble.setText(text);
        bubble.measure(
                View.MeasureSpec.makeMeasureSpec(
                        WINDOW_WIDTHS[sizeIndex] - 12,
                        View.MeasureSpec.AT_MOST),
                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        updatePetTopMargin(bubble.getMeasuredHeight() + dp(4));
        bubble.setVisibility(View.VISIBLE);
        handler.removeCallbacks(hideBubble);
        handler.postDelayed(hideBubble, 2800);
    }

    private void hideBubble() {
        if (bubble == null) {
            return;
        }
        bubble.setVisibility(View.GONE);
        updatePetTopMargin(dp(4));
    }

    private void updatePetTopMargin(int topMargin) {
        if (topMargin == petTopMargin || params == null || petLayoutParams == null) {
            return;
        }

        int petTop = params.y + petTopMargin;
        petTopMargin = topMargin;
        petLayoutParams.topMargin = petTopMargin;
        pet.setLayoutParams(petLayoutParams);
        params.height = windowHeight();
        params.y = petTop - petTopMargin;
        clampPosition();
        updateOverlayLayout();
    }

    private void scheduleAutoAction() {
        handler.removeCallbacks(autoAction);
        if (!autoActions || pet == null) {
            return;
        }
        handler.postDelayed(autoAction, 8000 + random.nextInt(8000));
    }

    private void scheduleBlink() {
        handler.removeCallbacks(blink);
        if (pet != null) {
            handler.postDelayed(blink, 2500 + random.nextInt(3500));
        }
    }

    private void updateOverlayLayout() {
        if (overlay == null || windowManager == null || params == null) {
            return;
        }
        try {
            windowManager.updateViewLayout(overlay, params);
        } catch (IllegalArgumentException ignored) {
            // 视图已经移除时忽略更新。
        }
    }

    private void clampPosition() {
        if (params == null) {
            return;
        }
        params.x = clamp(params.x, minX(), maxX());
        params.y = clamp(params.y, minY(), maxY());
    }

    private int minX() {
        return 0;
    }

    private int maxX() {
        return Math.max(0, screenWidth() - params.width);
    }

    private int minY() {
        return -petTopMargin();
    }

    private int maxY() {
        return screenHeight() - petTopMargin() - PET_HEIGHTS[sizeIndex];
    }

    private int defaultX() {
        return maxX() - 24;
    }

    private int defaultY() {
        return maxY() - 80;
    }

    private int petTopMargin() {
        return petTopMargin;
    }

    private int windowHeight() {
        return petTopMargin() + PET_HEIGHTS[sizeIndex] + WINDOW_BOTTOM_PADDINGS[sizeIndex];
    }

    private int screenWidth() {
        return getResources().getDisplayMetrics().widthPixels;
    }

    private int screenHeight() {
        return getResources().getDisplayMetrics().heightPixels;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void saveSettings() {
        if (preferences == null || params == null) {
            return;
        }
        preferences.edit()
                .putInt("x", params.x)
                .putInt("y", params.y)
                .putInt("size_index", sizeIndex)
                .putBoolean("auto_actions", autoActions)
                .putBoolean("mirrored", mirrored)
                .putString("character", character)
                .apply();
    }

    private int openImageResource() {
        return CHARACTER_WINDY.equals(character)
                ? R.drawable.windy_pet
                : R.drawable.aliya_pet;
    }

    private int blinkImageResource() {
        return CHARACTER_WINDY.equals(character)
                ? R.drawable.windy_pet_blink
                : R.drawable.aliya_pet_blink;
    }

    private static String normalizeCharacter(String character) {
        return CHARACTER_WINDY.equals(character) ? CHARACTER_WINDY : CHARACTER_ALIYA;
    }

    private void createChannel() {
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.channel_name),
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Aliya 桌面宠物前台服务");
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        handler.postDelayed(() -> {
            clampPosition();
            updateOverlayLayout();
            saveSettings();
        }, 200);
    }

    @Override
    public void onDestroy() {
        running = false;
        handler.removeCallbacksAndMessages(null);
        cancelCurrentAction();
        saveSettings();

        if (overlay != null && windowManager != null) {
            try {
                windowManager.removeView(overlay);
            } catch (IllegalArgumentException ignored) {
                // 视图已经移除。
            }
            overlay = null;
        }

        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    public static boolean isRunning() {
        return running;
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    private static float clamp(float value, float min, float max) {
        return Math.max(min, Math.min(max, value));
    }
}
