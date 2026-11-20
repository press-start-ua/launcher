"""Press Start UA Launcher window: the translated games as a shelf of covers, and patching the user's own image.

Library page: a grid of covers from the catalog. A click on a cover opens the game page: the
cover, version, date, what is new, discs, and the patching panel (pick a clean image or drop it
on the window, the disc is recognised, pick ISO / WBFS / Riivolution, press «Перекласти»).
An image dropped on the library page opens the page of its game by itself. Long work runs in a
background thread and reports into the progress bar and the log.

usage: .venv/bin/python app.py [--catalog SRC]     SRC: catalog.json path or https URL
"""
import os, sys, traceback
sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from PySide6.QtCore import QByteArray, QObject, QRectF, QSettings, QSize, Qt, QThread, QUrl, Signal
from PySide6.QtGui import QAction, QColor, QDesktopServices, QFont, QIcon, QPainter, QPainterPath, QPixmap
from PySide6.QtSvg import QSvgRenderer
from PySide6.QtWidgets import (QApplication, QStyle, QStyledItemDelegate, QButtonGroup, QDialog, QDialogButtonBox,
                               QFileDialog, QFrame, QHBoxLayout, QLabel, QLineEdit, QListView,
                               QListWidget, QListWidgetItem, QMainWindow, QMessageBox, QPlainTextEdit,
                               QProgressBar, QPushButton, QRadioButton, QSizePolicy, QSlider,
                               QStackedWidget, QTextBrowser, QToolBar, QVBoxLayout, QWidget)

from uapatch import PatchError, read_patch
from uapatch.apply import default_output, disc_id, patch_image, patch_riivolution
from uapatch.catalog import Catalog, cache_dir

import texts

APP = 'Press Start UA Launcher'
VERSION = '0.1'
# The live list is read from GitHub; the copy shipped with the program is the fallback when offline.
ONLINE_CATALOG = 'https://raw.githubusercontent.com/press-start-ua/launcher/main/catalog/catalog.json'
LOCAL_CATALOG = os.path.join(getattr(sys, '_MEIPASS', HERE), 'catalog', 'catalog.json')
DEFAULT_CATALOG = os.environ.get('UAPATCH_CATALOG') or ONLINE_CATALOG
IMAGES = 'Образи Wii (*.iso *.wbfs *.ciso *.wdf *.wia *.gcz);;Усі файли (*)'
FORMATS = [('iso', 'ISO', 'для Dolphin'), ('wbfs', 'WBFS', 'для Wii через USB-завантажувач'),
           ('riivolution', 'Riivolution', 'для Wii з оригінальним диском (SD-картка)')]
COVER_MIN, COVER_MAX, COVER_DEFAULT = 140, 300, 210   # cover width on the shelf (height = 4/3)
BIG = QSize(240, 320)       # on the game page

STYLE = '''
QMainWindow, QWidget#root, QWidget#page { background: #f4f1ea; }
QDialog { background: #f4f1ea; }
QToolBar#tools { background: #fbf9f4; border: none; border-bottom: 1px solid #e0d8c8; padding: 4px 8px; spacing: 2px; }
QToolBar#tools QToolButton { font-size: 12px; color: #2b2620; padding: 4px 10px; border-radius: 6px; }
QToolBar#tools QToolButton:hover { background: #ebe4d6; }
QToolBar#tools QToolButton:pressed { background: #e2d9c7; }
QLabel#apptitle { font-size: 22px; font-weight: 700; color: #2b2620; }
QListWidget#shelf { background: transparent; border: none; outline: none; font-size: 14px; }
QListWidget#shelf::item { color: #2b2620; border-radius: 12px; padding: 8px; }
QListWidget#shelf::item:hover { background: #ebe4d6; }
QListWidget#shelf::item:selected { background: #e2d9c7; color: #2b2620; }
QFrame#card { background: #fffdf8; border: 1px solid #e0d8c8; border-radius: 12px; }
QLabel#title { font-size: 26px; font-weight: 700; color: #2b2620; }
QLabel#meta { color: #7a6f60; font-size: 13px; }
QLabel#h { font-size: 13px; font-weight: 700; color: #7a6f60; letter-spacing: 1px; }
QLabel#body { font-size: 14px; color: #2b2620; }
QLabel#ok { color: #2f6f4f; font-weight: 600; }
QLabel#warn { color: #b0442c; font-weight: 600; }
QLabel#drop { color: #7a6f60; font-size: 13px; border: 2px dashed #d6ccb8; border-radius: 10px; padding: 12px; }
QLineEdit { background: white; border: 1px solid #d6ccb8; border-radius: 6px; padding: 7px; font-size: 13px; }
QPushButton { background: #ebe4d6; border: 1px solid #d6ccb8; border-radius: 6px; padding: 7px 14px; font-size: 13px; }
QPushButton:hover { background: #e2d9c7; }
QPushButton#back { background: transparent; border: none; font-size: 14px; font-weight: 600; color: #2f6f4f;
                   padding: 4px 2px; text-align: left; }
QPushButton#back:hover { color: #1f4f37; }
QPushButton#go { background: #2f6f4f; color: white; border: none; font-size: 15px; font-weight: 700;
                 padding: 11px 26px; border-radius: 8px; }
QPushButton#go:hover { background: #285f43; }
QPushButton#go:disabled { background: #a9b8ae; }
QRadioButton { font-size: 13px; color: #2b2620; spacing: 8px; }
QProgressBar { border: none; background: #e7e0d2; border-radius: 5px; height: 10px; text-align: center; }
QProgressBar::chunk { background: #2f6f4f; border-radius: 5px; }
QPlainTextEdit { background: #fbf9f4; border: 1px solid #e0d8c8; border-radius: 6px;
                 font-family: Menlo, Consolas, monospace; font-size: 12px; color: #4a4238; }
'''


# Toolbar icons, drawn here as simple line pictures (24x24), no icon set from elsewhere.
_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="{c}" '
        'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">{d}</svg>')
ICONS = {
    'open': '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>'
            '<path d="M12 5.5a6.5 6.5 0 0 1 6.5 6.5"/>',
    'reload': '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    'settings': '<path d="M12.00 4.80 L13.85 2.68 L15.64 3.22 L16.00 6.01 L17.09 6.91 L19.90 6.72 L20.78 8.36 L19.06 10.60 L19.20 12.00 L21.32 13.85 L20.78 15.64 L17.99 16.00 L17.09 17.09 L17.28 19.90 L15.64 20.78 L13.40 19.06 L12.00 19.20 L10.15 21.32 L8.36 20.78 L8.00 17.99 L6.91 17.09 L4.10 17.28 L3.22 15.64 L4.94 13.40 L4.80 12.00 L2.68 10.15 L3.22 8.36 L6.01 8.00 L6.91 6.91 L6.72 4.10 L8.36 3.22 L10.60 4.94 Z"/><circle cx="12" cy="12" r="3"/>',
    'help': '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.3a2.6 2.6 0 0 1 5 .9c0 1.8-2.5 2.3-2.5 4"/>'
            '<circle cx="12" cy="17.3" r=".6" fill="{c}"/>',
    'about': '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r=".6" fill="{c}"/>',
    'one': '<rect x="7" y="5" width="10" height="14" rx="2"/>',
    'many': '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="9" rx="1.5"/>'
           '<rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
}


def icon(name, color='#2b2620', size=48):
    svg = _SVG.format(c=color, d=ICONS[name].replace('{c}', color))
    pm = QPixmap(size, size)
    pm.fill(Qt.transparent)
    p = QPainter(pm)
    QSvgRenderer(QByteArray(svg.encode())).render(p)
    p.end()
    return QIcon(pm)


def placeholder(title, size):
    """A coloured card with the game's initials, while a cover is missing or loading."""
    pm = QPixmap(size)
    pm.fill(Qt.transparent)
    p = QPainter(pm)
    p.setRenderHint(QPainter.Antialiasing)
    hue = sum(map(ord, title)) * 37 % 360
    p.setBrush(QColor.fromHsl(hue, 120, 110))
    p.setPen(Qt.NoPen)
    p.drawRoundedRect(pm.rect(), 14, 14)
    p.setPen(QColor('white'))
    f = QFont()
    f.setPixelSize(size.width() // 4)
    f.setBold(True)
    p.setFont(f)
    letters = ''.join(w[0] for w in title.split() if w[0].isalnum())[:2].upper()
    p.drawText(pm.rect(), Qt.AlignCenter, letters)
    p.end()
    return pm


STATUS = {'beta': ('БЕТА', '#d9822b'), 'done': ('ЗАВЕРШЕНО', '#2f6f4f')}


def with_badge(pm, status):
    """The translation's status as a pill in the top-right corner of a cover."""
    if status not in STATUS:
        return pm
    text, color = STATUS[status]
    pm = QPixmap(pm)
    p = QPainter(pm)
    p.setRenderHint(QPainter.Antialiasing)
    f = QFont()
    f.setPixelSize(max(10, pm.width() // 19))
    f.setBold(True)
    f.setLetterSpacing(QFont.AbsoluteSpacing, 0.6)
    p.setFont(f)
    fm = p.fontMetrics()
    pad_x, pad_y = f.pixelSize() * 0.75, f.pixelSize() * 0.4
    w, h = fm.horizontalAdvance(text) + 2 * pad_x, fm.height() + 2 * pad_y
    m = pm.width() * 0.05
    rect = QRectF(pm.width() - m - w, m, w, h)
    p.setPen(Qt.NoPen)
    p.setBrush(QColor(0, 0, 0, 60))
    p.drawRoundedRect(rect.translated(0, 2), h / 2, h / 2)
    p.setBrush(QColor(color))
    p.drawRoundedRect(rect, h / 2, h / 2)
    p.setPen(QColor('white'))
    p.drawText(rect, Qt.AlignCenter, text)
    p.end()
    return pm


def rounded(path, size, radius=14):
    """The cover file scaled into size with rounded corners (None if it cannot be read)."""
    src = QPixmap(path)
    if src.isNull():
        return None
    src = src.scaled(size, Qt.KeepAspectRatioByExpanding, Qt.SmoothTransformation)
    pm = QPixmap(size)
    pm.fill(Qt.transparent)
    p = QPainter(pm)
    p.setRenderHint(QPainter.Antialiasing)
    clip = QPainterPath()
    clip.addRoundedRect(0, 0, size.width(), size.height(), radius, radius)
    p.setClipPath(clip)
    p.drawPixmap((size.width() - src.width()) // 2, (size.height() - src.height()) // 2, src)
    p.end()
    return pm


class ShelfDelegate(QStyledItemDelegate):
    """A shelf item: the cover, then the title (up to two lines) and the version in grey."""
    PAD = 8

    def __init__(self, window):
        super().__init__(window)
        self.window = window

    def sizeHint(self, option, index):
        size = self.window.cover_size()
        return QSize(size.width() + 36, size.height() + 96)

    def paint(self, p, option, index):
        p.save()
        p.setRenderHint(QPainter.Antialiasing)
        r = option.rect.adjusted(4, 4, -4, -4)
        if option.state & (QStyle.State_Selected | QStyle.State_MouseOver):
            p.setPen(Qt.NoPen)
            p.setBrush(QColor('#e2d9c7' if option.state & QStyle.State_Selected else '#ebe4d6'))
            p.drawRoundedRect(r, 12, 12)
        size = self.window.cover_size()
        pm = index.data(Qt.DecorationRole).pixmap(size)
        x = r.x() + (r.width() - size.width()) // 2
        p.drawPixmap(x, r.y() + self.PAD, pm)
        top = r.y() + self.PAD + size.height() + 6
        f = QFont(option.font)
        f.setPixelSize(14)
        p.setFont(f)
        p.setPen(QColor('#2b2620'))
        text_rect = p.boundingRect(r.x() + 6, top, r.width() - 12, 40, Qt.AlignHCenter | Qt.TextWordWrap,
                                   index.data(Qt.DisplayRole))
        text_rect.setHeight(min(text_rect.height(), 40))
        p.drawText(text_rect, Qt.AlignHCenter | Qt.TextWordWrap, index.data(Qt.DisplayRole))
        f.setPixelSize(12)
        p.setFont(f)
        p.setPen(QColor('#7a6f60'))
        p.drawText(r.x(), text_rect.bottom() + 2, r.width(), 18, Qt.AlignHCenter, index.data(Qt.UserRole + 1) or '')
        p.restore()


# ------------------------------------------------------------------ background work

class Worker(QObject):
    log = Signal(str)
    progress = Signal(int, int)
    done = Signal(object)
    failed = Signal(str)

    def __init__(self, fn):
        super().__init__()
        self.fn = fn

    def run(self):
        try:
            self.done.emit(self.fn(self))
        except PatchError as e:
            self.failed.emit(str(e))
        except Exception:  # an unexpected bug: show it rather than close silently
            self.failed.emit('Непередбачена помилка:\n' + traceback.format_exc())


def start(owner, fn, on_done, on_failed, on_log=None, on_progress=None):
    thread, worker = QThread(owner), Worker(fn)
    worker.moveToThread(thread)
    thread.started.connect(worker.run)
    worker.done.connect(on_done)
    worker.failed.connect(on_failed)
    if on_log:
        worker.log.connect(on_log)
    if on_progress:
        worker.progress.connect(on_progress)
    for sig in (worker.done, worker.failed):
        sig.connect(thread.quit)
    thread.finished.connect(worker.deleteLater)
    thread.finished.connect(thread.deleteLater)
    owner._jobs.append((thread, worker))  # keep them alive
    thread.start()


# ------------------------------------------------------------------ window

class Window(QMainWindow):
    def __init__(self, source):
        super().__init__()
        self._jobs = []
        self.source = source
        self.catalog = None
        self.covers = {}        # game id -> local cover path
        self.game_row = -1      # the game shown on the game page
        self.image = None
        self.image_id = None
        self.busy = False
        self.settings = QSettings('PressStartUA', 'Launcher')
        self.cover_w = self.int_setting('cover', COVER_DEFAULT, COVER_MIN, COVER_MAX)
        self.setWindowTitle(APP)
        self.resize(1060, 760)
        self.setAcceptDrops(True)

        self.pages = QStackedWidget(objectName='root')
        self.setCentralWidget(self.pages)
        self.pages.addWidget(self.build_library())
        self.pages.addWidget(self.build_game())
        self.build_toolbar()
        self.pages.currentChanged.connect(self.on_page)
        self.on_page(0)
        self.load_catalog()

    def int_setting(self, key, default, lo, hi):
        try:
            return max(lo, min(hi, int(self.settings.value(key, default))))
        except (TypeError, ValueError):
            return default

    def cover_size(self):
        return QSize(self.cover_w, self.cover_w * 4 // 3)

    # -------------------------------------------------------------- toolbar

    def build_toolbar(self):
        bar = QToolBar('Меню')
        bar.setObjectName('tools')
        bar.setMovable(False)
        bar.setFloatable(False)
        bar.setIconSize(QSize(26, 26))
        bar.setToolButtonStyle(Qt.ToolButtonTextUnderIcon)
        bar.setContextMenuPolicy(Qt.PreventContextMenu)
        self.addToolBar(Qt.TopToolBarArea, bar)

        def act(name, text, fn, tip):
            a = QAction(icon(name), text, self)
            a.setToolTip(tip)
            a.triggered.connect(fn)
            bar.addAction(a)
            return a

        self.act_open = act('open', 'Відкрити образ', self.pick_image,
                            'Вибрати образ гри: програма сама знайде для нього переклад')
        self.act_reload = act('reload', 'Оновити', self.load_catalog, 'Завантажити свіжий список перекладів')
        bar.addSeparator()

        size = QWidget()
        sl = QHBoxLayout(size)
        sl.setContentsMargins(10, 0, 10, 0)
        sl.setSpacing(6)
        small = QLabel()
        small.setPixmap(icon('many', '#7a6f60', 36).pixmap(18, 18))
        sl.addWidget(small)
        self.size_slider = QSlider(Qt.Horizontal)
        self.size_slider.setRange(COVER_MIN, COVER_MAX)
        self.size_slider.setValue(self.cover_w)
        self.size_slider.setFixedWidth(130)
        self.size_slider.setToolTip('Розмір обкладинок')
        self.size_slider.valueChanged.connect(self.set_cover_width)
        sl.addWidget(self.size_slider)
        big = QLabel()
        big.setPixmap(icon('one', '#7a6f60', 36).pixmap(18, 18))
        sl.addWidget(big)
        self.size_box = bar.addWidget(size)
        bar.addSeparator()

        act('settings', 'Налаштування', self.open_settings, 'Куди зберігати результат, формат, кеш')
        act('help', 'Довідка', lambda: self.show_text('Довідка', texts.HELP), 'Як отримати образ і як грати')
        act('about', 'Про програму', self.show_about, 'Версія та ліцензії')

        spacer = QWidget()
        spacer.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        bar.addWidget(spacer)
        self.search = QLineEdit()
        self.search.setPlaceholderText('Пошук…')
        self.search.setClearButtonEnabled(True)
        self.search.setFixedWidth(220)
        self.search.textChanged.connect(self.filter_shelf)
        box = QWidget()
        bl = QHBoxLayout(box)
        bl.setContentsMargins(0, 0, 8, 0)
        bl.addWidget(self.search)
        self.search_box = bar.addWidget(box)

    def on_page(self, index):
        """The shelf-only tools are hidden on a game page; nothing changes the catalog mid-patch."""
        self.size_box.setVisible(index == 0)
        self.search_box.setVisible(index == 0)

    def set_cover_width(self, w):
        self.cover_w = w
        self.settings.setValue('cover', w)
        self.apply_cover_size()

    def apply_cover_size(self):
        size = self.cover_size()
        self.shelf.setIconSize(size)
        self.shelf.setGridSize(QSize(size.width() + 36, size.height() + 96))
        if self.catalog:
            for i in range(self.shelf.count()):
                it = self.shelf.item(i)
                g = self.catalog.games[it.data(Qt.UserRole)]
                path = self.covers.get(g['id'])
                pm = (rounded(path, size) if path else None) or placeholder(g['title'], size)
                it.setIcon(QIcon(with_badge(pm, g.get('status'))))

    # -------------------------------------------------------------- pages

    def build_library(self):
        page = QWidget(objectName='page')
        lay = QVBoxLayout(page)
        lay.setContentsMargins(24, 20, 24, 16)
        lay.setSpacing(12)
        lay.addWidget(QLabel('Українські переклади ігор Wii', objectName='apptitle'))

        self.shelf = QListWidget(objectName='shelf')
        self.shelf.setViewMode(QListView.IconMode)
        self.shelf.setIconSize(self.cover_size())
        self.shelf.setGridSize(QSize(self.cover_w + 36, self.cover_size().height() + 96))
        self.shelf.setResizeMode(QListView.Adjust)
        self.shelf.setMovement(QListView.Static)
        self.shelf.setWordWrap(True)
        self.shelf.setSpacing(6)
        self.shelf.setItemDelegate(ShelfDelegate(self))
        self.shelf.setMouseTracking(True)
        self.shelf.setCursor(Qt.PointingHandCursor)
        self.shelf.itemClicked.connect(lambda it: self.open_game(it.data(Qt.UserRole)))
        self.shelf.itemActivated.connect(lambda it: self.open_game(it.data(Qt.UserRole)))
        lay.addWidget(self.shelf, 1)

        bottom = QHBoxLayout()
        self.lib_state = QLabel('Натисніть на гру, щоб перекласти її. Або просто перетягніть свій образ '
                                'гри у вікно: програма сама знайде переклад.', objectName='meta')
        self.lib_state.setWordWrap(True)
        bottom.addWidget(self.lib_state, 1)
        self.cat_info = QLabel('', objectName='meta')
        bottom.addWidget(self.cat_info)
        lay.addLayout(bottom)
        return page

    def build_game(self):
        page = QWidget(objectName='page')
        lay = QVBoxLayout(page)
        lay.setContentsMargins(24, 14, 24, 20)
        lay.setSpacing(10)
        back = QPushButton('←  Усі ігри', objectName='back')
        back.setCursor(Qt.PointingHandCursor)
        back.clicked.connect(self.show_library)
        lay.addWidget(back, 0, Qt.AlignLeft)

        body = QHBoxLayout()
        body.setSpacing(20)
        lay.addLayout(body, 1)

        # left: cover and the game card
        left = QVBoxLayout()
        left.setSpacing(12)
        self.cover = QLabel()
        self.cover.setFixedSize(BIG)
        left.addWidget(self.cover)
        self.title = QLabel('', objectName='title')
        self.title.setWordWrap(True)
        self.title.setFixedWidth(BIG.width())
        left.addWidget(self.title)
        self.meta = QLabel('', objectName='meta')
        self.meta.setWordWrap(True)
        self.meta.setFixedWidth(BIG.width())
        left.addWidget(self.meta)
        left.addSpacing(4)
        left.addWidget(QLabel('ЩО НОВОГО', objectName='h'))
        self.changes = QLabel('', objectName='body')
        self.changes.setWordWrap(True)
        self.changes.setFixedWidth(BIG.width())
        self.changes.setTextFormat(Qt.RichText)
        left.addWidget(self.changes)
        left.addSpacing(4)
        left.addWidget(QLabel('ДИСКИ', objectName='h'))
        self.discs = QLabel('', objectName='body')
        self.discs.setWordWrap(True)
        self.discs.setFixedWidth(BIG.width())
        left.addWidget(self.discs)
        left.addStretch(1)
        body.addLayout(left)

        # right: the patching panel
        panel = QFrame(objectName='card')
        pl = QVBoxLayout(panel)
        pl.setContentsMargins(20, 20, 20, 20)
        pl.setSpacing(10)
        pl.addWidget(QLabel('ВАШ ОБРАЗ ГРИ', objectName='h'))
        row = QHBoxLayout()
        self.path = QLineEdit()
        self.path.setPlaceholderText('Виберіть чистий образ (ISO, WBFS…) або перетягніть його у вікно')
        self.path.setReadOnly(True)
        row.addWidget(self.path, 1)
        pick = QPushButton('Вибрати…')
        pick.clicked.connect(self.pick_image)
        row.addWidget(pick)
        pl.addLayout(row)
        self.found = QLabel('', objectName='meta')
        self.found.setWordWrap(True)
        pl.addWidget(self.found)
        pl.addSpacing(6)

        pl.addWidget(QLabel('ФОРМАТ РЕЗУЛЬТАТУ', objectName='h'))
        self.fmt = QButtonGroup(self)
        for i, (key, name, hint) in enumerate(FORMATS):
            b = QRadioButton(f'{name} — {hint}')
            b.setProperty('fmt', key)
            self.fmt.addButton(b, i)
            pl.addWidget(b)
            if key == self.default_format():
                b.setChecked(True)
        pl.addSpacing(6)

        go_row = QHBoxLayout()
        self.go = QPushButton('Перекласти', objectName='go')
        self.go.setEnabled(False)
        self.go.clicked.connect(self.run_patch)
        go_row.addWidget(self.go)
        self.state = QLabel('', objectName='meta')
        self.state.setWordWrap(True)
        go_row.addWidget(self.state, 1)
        pl.addLayout(go_row)
        self.bar = QProgressBar()
        self.bar.setTextVisible(False)
        self.bar.setValue(0)
        pl.addWidget(self.bar)
        self.logbox = QPlainTextEdit()
        self.logbox.setReadOnly(True)
        self.logbox.setPlaceholderText('Тут буде видно, що робить програма.')
        self.logbox.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        pl.addWidget(self.logbox, 1)
        body.addWidget(panel, 1)
        return page

    def show_library(self):
        if self.busy:
            QMessageBox.information(self, APP, 'Зачекайте, поки закінчиться переклад.')
            return
        self.pages.setCurrentIndex(0)

    # -------------------------------------------------------------- dialogs

    def out_folder(self):
        """The folder chosen in the settings, or None for «next to the image»."""
        folder = self.settings.value('out_dir', '') or ''
        return folder if self.settings.value('out_mode', 'beside') == 'folder' and os.path.isdir(folder) else None

    def default_format(self):
        fmt = self.settings.value('format', 'iso')
        return fmt if fmt in [f[0] for f in FORMATS] else 'iso'

    def open_settings(self):
        d = QDialog(self)
        d.setWindowTitle('Налаштування')
        d.setMinimumWidth(520)
        lay = QVBoxLayout(d)
        lay.setSpacing(10)
        lay.setContentsMargins(20, 20, 20, 16)

        lay.addWidget(QLabel('КУДИ ЗБЕРІГАТИ РЕЗУЛЬТАТ', objectName='h'))
        beside = QRadioButton('Поруч з образом гри')
        chosen = QRadioButton('У вибрану папку:')
        group = QButtonGroup(d)
        group.addButton(beside)
        group.addButton(chosen)
        lay.addWidget(beside)
        row = QHBoxLayout()
        row.addWidget(chosen)
        folder = QLineEdit(self.settings.value('out_dir', '') or '')
        folder.setReadOnly(True)
        folder.setPlaceholderText('папку не вибрано')
        row.addWidget(folder, 1)
        browse = QPushButton('Вибрати…')
        row.addWidget(browse)
        lay.addLayout(row)
        (chosen if self.settings.value('out_mode', 'beside') == 'folder' else beside).setChecked(True)

        def pick():
            path = QFileDialog.getExistingDirectory(d, 'Куди зберігати', folder.text() or os.path.expanduser('~'))
            if path:
                folder.setText(path)
                chosen.setChecked(True)
        browse.clicked.connect(pick)

        lay.addSpacing(6)
        lay.addWidget(QLabel('ФОРМАТ ЗА ЗАМОВЧУВАННЯМ', objectName='h'))
        fmt = QButtonGroup(d)
        for key, name, hint in FORMATS:
            b = QRadioButton(f'{name} — {hint}')
            b.setProperty('fmt', key)
            b.setChecked(key == self.default_format())
            fmt.addButton(b)
            lay.addWidget(b)

        lay.addSpacing(6)
        lay.addWidget(QLabel('ЗАВАНТАЖЕНІ ПАТЧІ', objectName='h'))
        cache_info = QLabel('', objectName='meta')
        cache_info.setWordWrap(True)
        lay.addWidget(cache_info)
        clear = QPushButton('Очистити кеш')
        lay.addWidget(clear, 0, Qt.AlignLeft)

        def cache_files():
            base = cache_dir()
            return [os.path.join(base, n) for n in os.listdir(base)
                    if n.endswith(('.uapatch', '.part', '.png'))]

        def show_cache():
            files = cache_files()
            mb = sum(os.path.getsize(f) for f in files) / 1024 ** 2
            cache_info.setText(f'{len(files)} файлів, {mb:.1f} МБ. Програма завантажить їх знову, коли знадобляться.')
            clear.setEnabled(bool(files))

        def clear_cache():
            for f in cache_files():
                try:
                    os.unlink(f)
                except OSError:
                    pass
            show_cache()
        clear.clicked.connect(clear_cache)
        show_cache()

        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.button(QDialogButtonBox.Ok).setText('Зберегти')
        buttons.button(QDialogButtonBox.Cancel).setText('Скасувати')
        buttons.accepted.connect(d.accept)
        buttons.rejected.connect(d.reject)
        lay.addSpacing(8)
        lay.addWidget(buttons)
        if d.exec() != QDialog.Accepted:
            return
        if chosen.isChecked() and not os.path.isdir(folder.text()):
            QMessageBox.warning(self, APP, 'Папку не вибрано, тому результат і далі буде поруч з образом.')
            self.settings.setValue('out_mode', 'beside')
        else:
            self.settings.setValue('out_mode', 'folder' if chosen.isChecked() else 'beside')
        self.settings.setValue('out_dir', folder.text())
        self.settings.setValue('format', fmt.checkedButton().property('fmt'))
        if not self.busy:
            self.select_format(fmt.checkedButton().property('fmt'))

    def select_format(self, key):
        for b in self.fmt.buttons():
            if b.property('fmt') == key:
                b.setChecked(True)

    def show_text(self, title, html, width=640, height=600):
        d = QDialog(self)
        d.setWindowTitle(title)
        d.resize(width, height)
        lay = QVBoxLayout(d)
        lay.setContentsMargins(0, 0, 0, 12)
        view = QTextBrowser()
        view.setOpenExternalLinks(True)
        view.setStyleSheet('QTextBrowser { border: none; background: #fffdf8; padding: 18px; font-size: 14px; }')
        view.setHtml(html)
        lay.addWidget(view, 1)
        ok = QPushButton('Закрити')
        ok.clicked.connect(d.accept)
        lay.addWidget(ok, 0, Qt.AlignCenter)
        d.exec()

    def show_about(self):
        self.show_text('Про програму', texts.about(APP, VERSION), 560, 520)

    # -------------------------------------------------------------- catalog

    def load_catalog(self):
        if self.busy:
            QMessageBox.information(self, APP, 'Зачекайте, поки закінчиться переклад.')
            return
        offline = False
        try:
            self.catalog = Catalog(self.source)
        except PatchError as e:
            try:
                if self.source == LOCAL_CATALOG:
                    raise
                self.catalog = Catalog(LOCAL_CATALOG)  # no connection: the list shipped with the program
                offline = True
            except PatchError:
                self.catalog = None
                self.shelf.clear()
                self.cat_info.setText('Не вдалося завантажити список ігор.')
                QMessageBox.warning(self, APP, str(e))
                return
        self.shelf.clear()
        for i, g in enumerate(self.catalog.games):
            it = QListWidgetItem(QIcon(with_badge(placeholder(g['title'], self.cover_size()), g.get('status'))),
                                 g['title'])
            it.setData(Qt.UserRole + 1, f'версія {g["version"]}')
            it.setData(Qt.UserRole, i)
            it.setTextAlignment(Qt.AlignHCenter | Qt.AlignTop)
            it.setToolTip(f'{g["title"]}\nПереклад версії {g["version"]} від {g["date"]}')
            self.shelf.addItem(it)
        self.cat_info.setText(f'Список від {self.catalog.updated}' +
                              (' (без з\'єднання: вбудований)' if offline else ''))
        self.filter_shelf(self.search.text())
        cat = self.catalog
        start(self, lambda w: {g['id']: cat.fetch_cover(g) for g in cat.games},
              self.on_covers, lambda msg: None)

    def on_covers(self, paths):
        self.covers.update({k: v for k, v in paths.items() if v})
        self.apply_cover_size()
        if self.game_row >= 0:
            self.show_game(self.game_row)

    def filter_shelf(self, text):
        text = text.strip().lower()
        for i in range(self.shelf.count()):
            it = self.shelf.item(i)
            it.setHidden(bool(text) and text not in it.text().lower())

    def current_game(self):
        r = self.game_row
        return self.catalog.games[r] if self.catalog and 0 <= r < len(self.catalog.games) else None

    def open_game(self, row):
        if row != self.game_row and not self.busy:
            self.game_row = row
            self.image, self.image_id = None, None
            self.path.clear()
            self.found.setText('')
            self.state.setText('')
            self.logbox.clear()
            self.bar.setRange(0, 1)
            self.bar.setValue(0)
            self.go.setEnabled(False)
        self.show_game(self.game_row)
        self.pages.setCurrentIndex(1)

    def show_game(self, row):
        g = self.current_game()
        if not g:
            return
        path = self.covers.get(g['id'])
        pm = (rounded(path, BIG) if path else None) or placeholder(g['title'], BIG)
        self.cover.setPixmap(with_badge(pm, g.get('status')))
        self.title.setText(g['title'])
        self.meta.setText(f'{g.get("platform", "Wii")} · переклад версії {g["version"]} від {g["date"]}')
        ch = g.get('changes') or ['—']
        self.changes.setText('<br>'.join('• ' + c.replace('&', '&amp;').replace('<', '&lt;') for c in ch))
        self.discs.setText('\n'.join(
            f'{d["game"]} — {d["region"]}' + (f' ({d["note"]})' if d.get('note') else '') for d in g['discs']))

    # -------------------------------------------------------------- image

    def dragEnterEvent(self, e):
        if e.mimeData().hasUrls() and not self.busy:
            e.acceptProposedAction()

    def dropEvent(self, e):
        urls = [u.toLocalFile() for u in e.mimeData().urls() if u.isLocalFile()]
        if urls:
            self.set_image(urls[0])

    def pick_image(self):
        path, _ = QFileDialog.getOpenFileName(self, 'Виберіть образ гри', os.path.expanduser('~'), IMAGES)
        if path:
            self.set_image(path)

    def say(self, text, kind='meta'):
        """A note about the image: on the game page, and on the shelf while it is shown."""
        self.found.setObjectName(kind)
        self.found.setText(text)
        self.restyle(self.found)
        if self.pages.currentIndex() == 0:
            self.lib_state.setObjectName(kind)
            self.lib_state.setText(text)
            self.restyle(self.lib_state)

    def set_image(self, path):
        if self.busy:
            return
        self.image, self.image_id = path, None
        self.path.setText(path)
        self.go.setEnabled(False)
        if path.lower().endswith('.rvz'):
            self.say('RVZ поки не підтримується. У Dolphin: правий клік на грі → «Convert File…» → ISO, '
                     'а тоді виберіть отриманий файл.', 'warn')
            return
        self.say('Розпізнаю диск…')
        start(self, lambda w: disc_id(path), self.on_id, lambda msg: self.say(msg, 'warn'))

    def on_id(self, gid):
        self.image_id = gid
        self.update_found()

    def update_found(self):
        if not self.image:
            return
        gid = self.image_id
        g, d = self.catalog.find_disc(gid) if (self.catalog and gid) else (None, None)
        if not gid:
            self.say('Не вдалося розпізнати образ. Це точно образ диска Wii?', 'warn')
        elif not g:
            self.say(f'Диск {gid}: для нього перекладу в списку немає.', 'warn')
        else:
            row = self.catalog.games.index(g)
            if row != self.game_row or self.pages.currentIndex() == 0:
                image, gid_ = self.image, self.image_id
                self.open_game(row)
                self.image, self.image_id = image, gid_
                self.path.setText(image)
            self.say(f'✓ {g["title"]}, {d["region"]} ({gid}). Буде застосовано переклад версії {g["version"]}.', 'ok')
            self.go.setEnabled(not self.busy)
            return
        self.go.setEnabled(False)

    @staticmethod
    def restyle(w):
        w.style().unpolish(w)
        w.style().polish(w)

    # -------------------------------------------------------------- patching

    def run_patch(self):
        g, d = self.catalog.find_disc(self.image_id)
        fmt = self.fmt.checkedButton().property('fmt')
        out = default_output(self.image, fmt)
        if self.out_folder():
            out = os.path.join(self.out_folder(), os.path.basename(out))
        if os.path.exists(out):
            if QMessageBox.question(self, APP, f'Вже існує:\n{out}\n\nЗамінити?') != QMessageBox.Yes:
                return
        src, cat = self.image, self.catalog

        def job(w):
            w.log.emit(f'Завантажую переклад {g["title"]} {g["version"]}…')
            path = cat.fetch_patch(d, lambda a, b: w.progress.emit(a, b or 1))
            head, blob = read_patch(path)
            if fmt == 'riivolution':
                return patch_riivolution(head, blob, src, out, True, w.log.emit, w.progress.emit)
            return patch_image(head, blob, src, out, fmt, True, w.log.emit, w.progress.emit)

        self.busy = True
        self.go.setEnabled(False)
        self.logbox.clear()
        self.bar.setRange(0, 0)  # busy until the first progress
        self.state.setText('Працюю… Це може зайняти кілька хвилин.')
        start(self, job, self.on_done, self.on_failed, self.logbox.appendPlainText, self.on_progress)

    def on_progress(self, done, total):
        self.bar.setRange(0, max(total, 1))
        self.bar.setValue(done)

    def finish(self):
        self.busy = False
        self.bar.setRange(0, 1)
        self.update_found()

    def on_done(self, out):
        self.finish()
        self.bar.setValue(1)
        self.state.setText('Готово!')
        msg = f'Готово!\n\n{out}'
        if os.path.isdir(out):
            msg += '\n\nСкопіюйте з цієї папки теки riivolution і теку перекладу в корінь SD-картки.'
        QMessageBox.information(self, APP, msg)

    def on_failed(self, msg):
        self.finish()
        self.bar.setValue(0)
        self.state.setText('Не вдалося.')
        self.logbox.appendPlainText('ПОМИЛКА: ' + msg)
        QMessageBox.warning(self, APP, msg)


def main():
    source = DEFAULT_CATALOG
    if '--catalog' in sys.argv:
        source = sys.argv[sys.argv.index('--catalog') + 1]
    app = QApplication(sys.argv)
    app.setApplicationName(APP)
    app.setStyleSheet(STYLE)
    w = Window(source)
    w.show()
    sys.exit(app.exec())


if __name__ == '__main__':
    main()
