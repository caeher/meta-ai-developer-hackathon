import Phaser from "phaser";
import { gameAudio } from "./audio";
import { completeGame, collectObjective, createGameState, moveGrid, moveTo, recordAction, takeDamage } from "./logic";
import {
  GAME_CONTROL_EVENT,
  GAME_OBJECTIVES,
  GAME_SNAPSHOT_EVENT,
  GAME_WIDTH,
  GAME_HEIGHT,
} from "./types";
import type { ControlMessage, GameControl, GameGenre, GameSnapshot, GameState } from "./types";

const GRID_COLUMNS = 12;
const GRID_ROWS = 7;
const GRID_SIZE = 56;
const GRID_LEFT = 144;
const GRID_TOP = 100;
const GRID_START = { x: 1, y: 1 };
const GRID_EXIT = { x: 10, y: 5 };
const GRID_OBJECTIVES = [
  { id: "crystal-1", x: 3, y: 1 },
  { id: "crystal-2", x: 5, y: 2 },
  { id: "crystal-3", x: 8, y: 4 },
] as const;
const GRID_WALLS: Readonly<Record<"puzzle" | "rpg", readonly (readonly [number, number])[]>> = {
  puzzle: [[4, 3], [5, 3], [6, 3]],
  rpg: [[3, 3], [4, 3], [5, 3]],
};
const GRID_HAZARDS: Readonly<Record<"puzzle" | "rpg", readonly (readonly [number, number])[]>> = {
  puzzle: [[2, 2], [3, 2], [2, 3]],
  rpg: [[2, 4], [6, 1], [9, 3]],
};

export class PlayScene extends Phaser.Scene {
  private genre!: GameGenre;
  private state!: GameState;
  private readonly held = new Set<GameControl>();
  private paused = false;
  private platformerPlayer?: Phaser.Physics.Arcade.Sprite;
  private platformerEnemy?: Phaser.Physics.Arcade.Sprite;
  private platformerPickups?: Phaser.Physics.Arcade.StaticGroup;
  private platformerInvulnerableUntil = 0;
  private gridPlayer?: Phaser.GameObjects.Image;
  private gridItems = new Map<string, Phaser.GameObjects.Image>();
  private gridWalls = new Set<string>();
  private shooterPlayer?: Phaser.Physics.Arcade.Image;
  private shooterEnemies?: Phaser.Physics.Arcade.Group;
  private shooterProjectiles: Array<Readonly<{ image: Phaser.Physics.Arcade.Image; collider: Phaser.Physics.Arcade.Collider }>> = [];
  private shooterInvulnerableUntil = 0;
  private nextSnapshotAt = 0;

  constructor() {
    super("PlayScene");
  }

  create(): void {
    this.genre = this.registry.get("genre") as GameGenre;
    this.state = createGameState(this.genre);
    this.held.clear();
    this.paused = false;
    this.registry.set("paused", false);
    this.registry.set("target", GAME_OBJECTIVES[this.genre]);
    this.game.events.on(GAME_CONTROL_EVENT, this.onControl, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown, this);
    this.scene.launch("HudScene");

    if (this.genre === "platformer") this.createPlatformer();
    else if (this.genre === "shooter") this.createShooter();
    else this.createGridGame();
    this.publishSnapshot();
  }

  update(time: number): void {
    if (this.paused || this.state.phase !== "playing") return;
    if (this.genre === "platformer") this.updatePlatformer(time);
    else if (this.genre === "shooter") this.updateShooter(time);
  }

  private readonly onControl = (message: ControlMessage): void => {
    if (message.kind === "command") {
      this.onCommand(message.command);
      return;
    }
    if (message.pressed) this.held.add(message.control);
    else this.held.delete(message.control);
    if (!message.pressed || this.state.phase !== "playing") return;

    if (message.control === "action") {
      this.state = recordAction(this.state);
      if (this.genre === "platformer") this.jump();
      else if (this.genre === "shooter") this.fire();
      else this.tryOpenGate();
      this.publishSnapshot();
      return;
    }

    if (this.genre === "puzzle" || this.genre === "rpg") this.moveGridPlayer(message.control);
  };

  private onCommand(command: "pause" | "mute" | "restart"): void {
    if (command === "restart") {
      this.scene.stop("HudScene");
      this.scene.restart();
      return;
    }
    if (command === "pause") {
      this.paused = !this.paused;
      if (this.paused) this.physics.world.pause();
      else this.physics.world.resume();
      this.registry.set("paused", this.paused);
      this.publishSnapshot();
      return;
    }
    gameAudio.toggleMute();
    this.publishSnapshot();
  }

  private createPlatformer(): void {
    const background = this.add.graphics();
    background.fillGradientStyle(0x24283b, 0x24283b, 0x1a1b26, 0x1a1b26, 1);
    background.fillRect(0, 76, GAME_WIDTH, GAME_HEIGHT - 76);

    const platforms = this.physics.add.staticGroup();
    addPlatform(platforms, 480, 520, 960, 40);
    addPlatform(platforms, 300, 315, 160, 18);
    addPlatform(platforms, 650, 235, 144, 18);

    this.platformerPlayer = this.physics.add.sprite(80, 462, "player").setDisplaySize(34, 38);
    this.platformerPlayer.setCollideWorldBounds(true).setBounce(0.03);
    this.platformerPlayer.body?.setSize(26, 34).setOffset(11, 10);
    this.physics.world.setBounds(0, 76, GAME_WIDTH, GAME_HEIGHT - 76);
    this.physics.add.collider(this.platformerPlayer, platforms);

    this.platformerPickups = this.physics.add.staticGroup();
    for (const [index, point] of [[230, 470], [410, 470], [705, 470]].entries()) {
      const pickup = this.platformerPickups.create(point[0]!, point[1]!, "crystal")
        .setDisplaySize(24, 30)
        .setData("objectiveId", `crystal-${index + 1}`);
      pickup.refreshBody();
    }
    this.physics.add.overlap(this.platformerPlayer, this.platformerPickups, (_player, pickup) => {
      const image = pickup as Phaser.Physics.Arcade.Image;
      this.collectObjective(image.getData("objectiveId") as string, image);
    });

    const gate = this.physics.add.staticImage(895, 472, "gate").setDisplaySize(44, 58);
    gate.refreshBody();
    this.physics.add.overlap(this.platformerPlayer, gate, () => this.tryOpenGate());

    this.platformerEnemy = this.physics.add.sprite(570, 480, "enemy").setDisplaySize(42, 34);
    this.platformerEnemy.setCollideWorldBounds(true).setBounceX(1).setVelocityX(90);
    this.physics.add.collider(this.platformerEnemy, platforms);
    this.physics.add.overlap(this.platformerPlayer, this.platformerEnemy, () => this.platformerHit());
    this.registry.set("worldHint", "Salta sobre el guardián para evitar perder una vida.");
  }

  private updatePlatformer(time: number): void {
    const player = this.platformerPlayer;
    const enemy = this.platformerEnemy;
    if (!player || !enemy) return;
    const direction = Number(this.held.has("right")) - Number(this.held.has("left"));
    player.setVelocityX(direction * 250);
    if (enemy.x < 520) enemy.setVelocityX(90);
    if (enemy.x > 650) enemy.setVelocityX(-90);
    if (player.y > GAME_HEIGHT + 30) this.platformerHit();
    if (time >= this.nextSnapshotAt) {
      this.nextSnapshotAt = time + 80;
      this.state = moveTo(this.state, Math.round(player.x), Math.round(player.y), false);
      this.publishSnapshot();
    }
  }

  private jump(): void {
    const player = this.platformerPlayer;
    const body = player?.body;
    if (!player || !body || (!body.blocked.down && !body.touching.down && player.y < 480)) return;
    player.setVelocityY(-440);
    gameAudio.playTone(510, 0.07);
  }

  private platformerHit(): void {
    if (!this.platformerPlayer || this.time.now < this.platformerInvulnerableUntil || this.state.phase !== "playing") return;
    this.platformerInvulnerableUntil = this.time.now + 5_000;
    this.state = takeDamage(this.state);
    if (this.state.phase === "playing") {
      this.platformerPlayer.setPosition(80, 462).setVelocity(0, 0);
    } else {
      this.platformerPlayer.setVelocity(0, 0);
    }
    gameAudio.playTone(170, 0.18);
    this.publishSnapshot();
  }

  private createGridGame(): void {
    this.add.rectangle(480, 300, 740, 416, 0x1a1b26, 0.45).setStrokeStyle(1, 0x414868);
    this.gridWalls.clear();
    const layout = this.genre === "puzzle" || this.genre === "rpg" ? GRID_WALLS[this.genre] : [];
    for (const [x, y] of layout) {
      this.gridWalls.add(`${x},${y}`);
      this.add.image(gridX(x), gridY(y), "tile").setDisplaySize(GRID_SIZE - 4, GRID_SIZE - 4).setTint(0x565f89);
    }
    this.gridPlayer = this.add.image(gridX(GRID_START.x), gridY(GRID_START.y), "player").setDisplaySize(38, 42).setDepth(5);
    this.add.image(gridX(GRID_EXIT.x), gridY(GRID_EXIT.y), "gate").setDisplaySize(42, 54).setDepth(2);
    this.gridItems.clear();
    for (const item of GRID_OBJECTIVES) {
      this.gridItems.set(item.id, this.add.image(gridX(item.x), gridY(item.y), "crystal").setDisplaySize(25, 32).setDepth(3));
    }
    const hazards = this.genre === "puzzle" || this.genre === "rpg" ? GRID_HAZARDS[this.genre] : [];
    for (const [x, y] of hazards) this.add.image(gridX(x), gridY(y), "enemy").setDisplaySize(34, 30).setDepth(1);
    this.registry.set("worldHint", this.genre === "puzzle"
      ? "La ficha se mueve una casilla por tecla. Las trampas quitan una vida y te devuelven al inicio."
      : "Explora la sala, esquiva guardianes, recoge las runas e interactúa con el portal.");
  }

  private moveGridPlayer(control: Extract<GameControl, "left" | "right" | "up" | "down">): void {
    const next = moveGrid(this.state, control, GRID_COLUMNS, GRID_ROWS, this.gridWalls);
    if (next === this.state) return;
    this.state = next;
    this.gridPlayer?.setPosition(gridX(this.state.x), gridY(this.state.y));
    gameAudio.playTone(390, 0.035);
    this.resolveGridCell();
    this.publishSnapshot();
  }

  private resolveGridCell(): void {
    const item = GRID_OBJECTIVES.find((entry) => entry.x === this.state.x && entry.y === this.state.y);
    if (item && !this.state.collectedIds.includes(item.id)) {
      this.state = collectObjective(this.state, item.id);
      this.gridItems.get(item.id)?.destroy();
      this.gridItems.delete(item.id);
      gameAudio.playTone(790, 0.1);
    }
    const hazards = this.genre === "puzzle" || this.genre === "rpg" ? GRID_HAZARDS[this.genre] : [];
    if (hazards.some(([x, y]) => x === this.state.x && y === this.state.y)) {
      this.state = takeDamage(this.state);
      if (this.state.phase === "playing") {
        this.state = moveTo(this.state, GRID_START.x, GRID_START.y, false);
        this.gridPlayer?.setPosition(gridX(GRID_START.x), gridY(GRID_START.y));
      }
      gameAudio.playTone(170, 0.16);
      return;
    }
    if (this.state.x === GRID_EXIT.x && this.state.y === GRID_EXIT.y) this.tryOpenGate();
  }

  private createShooter(): void {
    this.add.rectangle(480, 300, GAME_WIDTH, GAME_HEIGHT - 76, 0x1a1b26).setOrigin(0.5).setDepth(-2);
    this.shooterPlayer = this.physics.add.image(480, 475, "player").setDisplaySize(42, 46).setCollideWorldBounds(true);
    if (this.shooterPlayer.body) (this.shooterPlayer.body as Phaser.Physics.Arcade.Body).allowGravity = false;
    this.physics.world.setBounds(20, 76, GAME_WIDTH - 40, GAME_HEIGHT - 80);
    this.shooterEnemies = this.physics.add.group({ allowGravity: false });
    this.shooterProjectiles = [];
    for (let index = 0; index < GAME_OBJECTIVES.shooter; index += 1) {
      const enemy = this.physics.add.image(480, 105 + index * 48, "enemy").setDisplaySize(42, 34);
      enemy.setData("objectiveId", `drone-${index + 1}`);
      enemy.setVelocityY(15);
      this.shooterEnemies.add(enemy);
    }
    this.physics.add.overlap(this.shooterPlayer, this.shooterEnemies, (_player, enemy) => this.shooterHit(enemy as Phaser.Physics.Arcade.Image));
    this.registry.set("worldHint", "Los drones avanzan lentamente. Alínea tus disparos y evita que te alcancen.");
  }

  private updateShooter(time: number): void {
    const player = this.shooterPlayer;
    if (!player) return;
    const direction = Number(this.held.has("right")) - Number(this.held.has("left"));
    player.setVelocityX(direction * 280);
    for (const projectile of [...this.shooterProjectiles]) {
      if (!projectile.image.active || projectile.image.y < 75) this.removeProjectile(projectile.image);
    }
    for (const child of this.shooterEnemies?.getChildren() ?? []) {
      const enemy = child as Phaser.Physics.Arcade.Image;
      if (enemy.active && enemy.y > 440) this.shooterHit(enemy);
    }
    if (time >= this.nextSnapshotAt) {
      this.nextSnapshotAt = time + 80;
      this.state = moveTo(this.state, Math.round(player.x), Math.round(player.y), false);
      this.publishSnapshot();
    }
  }

  private fire(): void {
    const player = this.shooterPlayer;
    const enemies = this.shooterEnemies;
    if (!player || !enemies) return;
    const bullet = this.physics.add.image(player.x, player.y - 34, "bullet").setDisplaySize(11, 20);
    if (bullet.body) (bullet.body as Phaser.Physics.Arcade.Body).allowGravity = false;
    bullet.setVelocityY(-520);
    const collider = this.physics.add.overlap(bullet, enemies, (_projectile, enemy) => {
      this.hitShooterEnemy(bullet, enemy as Phaser.Physics.Arcade.Image);
    });
    this.shooterProjectiles.push({ image: bullet, collider });
    gameAudio.playTone(920, 0.045);
  }

  private hitShooterEnemy(bullet: Phaser.Physics.Arcade.Image, enemy: Phaser.Physics.Arcade.Image): void {
    if (this.state.phase !== "playing" || !enemy.active || !bullet.active) return;
    bullet.destroy();
    const id = enemy.getData("objectiveId") as string | undefined;
    if (id) this.state = collectObjective(this.state, id);
    enemy.destroy();
    if (this.state.score >= GAME_OBJECTIVES.shooter) this.state = completeGame(this.state);
    gameAudio.playTone(740, 0.09);
    this.publishSnapshot();
  }

  private shooterHit(enemy: Phaser.Physics.Arcade.Image): void {
    if (this.state.phase !== "playing" || this.time.now < this.shooterInvulnerableUntil) return;
    this.shooterInvulnerableUntil = this.time.now + 900;
    this.state = takeDamage(this.state);
    if (this.state.phase === "playing") {
      enemy.setPosition(480 + Phaser.Math.Between(-160, 160), 100);
      enemy.setVelocityY(15);
      this.shooterPlayer?.setPosition(480, 475);
    }
    gameAudio.playTone(170, 0.16);
    this.publishSnapshot();
  }

  private collectObjective(id: string, image: Phaser.GameObjects.Image): void {
    this.state = collectObjective(this.state, id);
    image.destroy();
    gameAudio.playTone(790, 0.1);
    this.publishSnapshot();
  }

  private tryOpenGate(): void {
    const previous = this.state.phase;
    this.state = completeGame(this.state);
    if (this.state.phase !== previous) gameAudio.playTone(1_040, 0.2);
    else if (this.genre === "platformer" || this.genre === "puzzle" || this.genre === "rpg") {
      this.registry.set("worldHint", `Te faltan ${Math.max(0, GAME_OBJECTIVES[this.genre] - this.state.score)} cristales.`);
    }
    this.publishSnapshot();
  }

  private publishSnapshot(): void {
    const snapshot: GameSnapshot = Object.freeze({
      ...this.state,
      velocityY: Math.round(this.genre === "platformer"
        ? (this.platformerPlayer?.body as Phaser.Physics.Arcade.Body | null)?.velocity.y ?? 0
        : this.genre === "shooter"
          ? (this.shooterPlayer?.body as Phaser.Physics.Arcade.Body | null)?.velocity.y ?? 0
          : 0),
      collectedIds: Object.freeze([...this.state.collectedIds]),
      target: GAME_OBJECTIVES[this.genre],
      targetsRemaining: this.genre === "shooter"
        ? this.shooterEnemies?.getChildren().filter((enemy) => enemy.active).length ?? GAME_OBJECTIVES.shooter
        : Math.max(0, GAME_OBJECTIVES[this.genre] - this.state.score),
      projectilesActive: this.genre === "shooter"
        ? this.shooterProjectiles.filter((projectile) => projectile.image.active).length
        : 0,
      muted: gameAudio.isMuted(),
      paused: this.paused,
      assetsReady: this.registry.get("assetsReady") === true,
      generatedAssetKeys: Object.freeze((this.registry.get("generatedAssets") as Array<{ key: string }> | undefined ?? []).map(({ key }) => key)),
    });
    this.registry.set("publicSnapshot", snapshot);
    this.game.events.emit(GAME_SNAPSHOT_EVENT, snapshot);
  }

  private onShutdown(): void {
    this.game.events.off(GAME_CONTROL_EVENT, this.onControl, this);
    for (const projectile of this.shooterProjectiles) {
      projectile.collider.destroy();
      projectile.image.destroy();
    }
    this.shooterProjectiles = [];
    this.held.clear();
    this.gridItems.clear();
    this.platformerPlayer = undefined;
    this.platformerEnemy = undefined;
    this.platformerPickups = undefined;
    this.gridPlayer = undefined;
    this.shooterPlayer = undefined;
    this.shooterEnemies = undefined;
    this.shooterProjectiles = [];
    this.paused = false;
  }

  private removeProjectile(image: Phaser.Physics.Arcade.Image): void {
    const index = this.shooterProjectiles.findIndex((projectile) => projectile.image === image);
    if (index < 0) return;
    const [projectile] = this.shooterProjectiles.splice(index, 1);
    projectile?.collider.destroy();
    image.destroy();
  }
}

function addPlatform(group: Phaser.Physics.Arcade.StaticGroup, x: number, y: number, width: number, height: number): void {
  group.create(x, y, "tile").setDisplaySize(width, height).refreshBody();
}

function gridX(column: number): number {
  return GRID_LEFT + column * GRID_SIZE + GRID_SIZE / 2;
}

function gridY(row: number): number {
  return GRID_TOP + row * GRID_SIZE + GRID_SIZE / 2;
}
