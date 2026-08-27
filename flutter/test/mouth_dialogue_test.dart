import 'package:aliya_pet/models/dialogue/dialogue_entry.dart';
import 'package:aliya_pet/models/dialogue/dialogue_file.dart';
import 'package:aliya_pet/models/mouth/mouth_shape.dart';
import 'package:aliya_pet/models/mouth/mouth_timeline.dart';
import 'package:aliya_pet/models/mouth/mouth_timeline_item.dart';
import 'package:aliya_pet/services/dialogue/dialogue_pagination_service.dart';
import 'package:aliya_pet/services/dialogue/dialogue_repository.dart';
import 'package:aliya_pet/services/dialogue/dialogue_selection_service.dart';
import 'package:aliya_pet/services/dialogue/dialogue_variable_service.dart';
import 'package:aliya_pet/services/dialogue/time_scene_service.dart';
import 'package:aliya_pet/services/mouth/pinyin_mouth_mapper.dart';
import 'package:aliya_pet/services/mouth/text_mouth_timeline_builder.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('PinyinMouthMapper', () {
    final mapper = PinyinMouthMapper();

    test('韵母分类正确', () {
      expect(mapper.getFinalCategory('大'), FinalCategory.a);
      expect(mapper.getFinalCategory('中'), FinalCategory.o);
      expect(mapper.getFinalCategory('的'), FinalCategory.e);
      expect(mapper.getFinalCategory('你'), FinalCategory.i);
      expect(mapper.getFinalCategory('不'), FinalCategory.u);
    });

    test('表外汉字回退 unknown', () {
      expect(mapper.getFinalCategory('龘'), FinalCategory.unknown);
    });

    test('闭嘴/软声母集合', () {
      expect(mapper.isClosedInit('不'), isTrue);
      expect(mapper.isClosedInit('大'), isFalse);
      expect(mapper.isSoftInit('发'), isTrue);
    });

    test('嘴型范围有效', () {
      for (final c in FinalCategory.values) {
        final shape = mapper.getShape(c, 0.5);
        expect(shape.openY, inInclusiveRange(0.0, 1.0));
        expect(shape.form, inInclusiveRange(-1.0, 1.0));
        expect(shape, isA<MouthShape>());
      }
    });
  });

  group('TextMouthTimelineBuilder', () {
    final builder = TextMouthTimelineBuilder(PinyinMouthMapper());

    test('空文本返回空时间轴', () {
      final tl = builder.build('');
      expect(tl.items, isEmpty);
      expect(tl.totalMilliseconds, 0);
    });

    test('生成汉字时间轴（非空、按时间排序、总时长>0）', () {
      final tl = builder.build('你好，今天开心吗？');
      expect(tl.items, isNotEmpty);
      expect(tl.totalMilliseconds, greaterThan(0));
      // 时间轴条目按时间递增
      for (var i = 1; i < tl.items.length; i++) {
        expect(tl.items[i].startMilliseconds,
            greaterThanOrEqualTo(tl.items[i - 1].startMilliseconds));
      }
      // 标点产生停顿项
      final pauses = tl.items.where((i) => i.isPause);
      expect(pauses, isNotEmpty);
    });

    test('人工分页符生成停顿', () {
      final tl = builder.build('第一页\\第二页');
      final pauses = tl.items.where((i) => i.isPause);
      expect(pauses, isNotEmpty);
      expect(pauses.first.durationMilliseconds, inInclusiveRange(350, 550));
    });

    test('数字展开为中文读法', () {
      final tl = builder.build('17');
      // 十、七 两个音节
      expect(tl.items.where((i) => !i.isPause).length, greaterThanOrEqualTo(2));
    });
  });

  group('MouthTimeline', () {
    test('itemAt 查询', () {
      final tl = MouthTimeline([
        MouthTimelineItem(0, 100, MouthShape(0.5, 0)),
        MouthTimelineItem(100, 200, MouthShape(0.8, 0.2)),
      ]);
      expect(tl.totalMilliseconds, 300);
      expect(tl.itemAt(50)!.shape.openY, 0.5);
      expect(tl.itemAt(150)!.shape.openY, 0.8);
      expect(tl.itemAt(300), isNull);
    });
  });

  group('DialoguePaginationService', () {
    final pagination = DialoguePaginationService();

    test('短文本单页', () {
      final pages = pagination.paginate('你好');
      expect(pages.length, 1);
      expect(pages.first.text, '你好');
    });

    test('人工分页符优先', () {
      final pages = pagination.paginate('第一页\\第二页');
      expect(pages.length, 2);
      expect(pages[0].text, '第一页');
      expect(pages[1].text, '第二页');
    });

    test('长文本智能分页不超过 maxPages', () {
      final long = '这是一个很长的句子，用于测试智能分页逻辑，确保不会超过最大页数限制，而且不会切断英文单词和数字1234567890。';
      final pages = pagination.paginate(long, maxPages: 3);
      expect(pages.length, lessThanOrEqualTo(3));
      final joined = pages.map((p) => p.text).join();
      expect(joined, contains('这是一个很长的句子'));
    });

    test('标点不单独开头', () {
      final pages = pagination.paginate('第一句，第二句。第三句！',
          singlePageMaxChars: 6);
      for (final page in pages) {
        expect('，。？！、；：…～·?,;:.'.contains(page.text[0]), isFalse);
      }
    });
  });

  group('DialogueSelectionService', () {
    test('shuffle_bag 一轮内不重复', () {
      final repo = _TestRepository.withEntries([
        _entry('a', '甲'),
        _entry('b', '乙'),
        _entry('c', '丙'),
      ], selectionMode: 'shuffle_bag');
      final service = DialogueSelectionService(repo);
      final picked = <String>{};
      for (var i = 0; i < 3; i++) {
        picked.add(service.select('test').id!);
      }
      expect(picked.length, 3); // 一轮内三个都不同
    });

    test('enabled=false 不抽取', () {
      final repo = _TestRepository.withEntries([
        _entry('a', '甲'),
        DialogueEntry(id: 'b', text: '乙', enabled: false),
      ]);
      final service = DialogueSelectionService(repo);
      expect(service.select('test').id, 'a');
    });

    test('空场景使用回退台词', () {
      final repo = _TestRepository.withEntries([]);
      final service = DialogueSelectionService(repo);
      final entry = service.select('user_click');
      expect(entry.id, startsWith('fallback'));
      expect(entry.text, isNotEmpty);
    });
  });

  group('TimeSceneService', () {
    final service = TimeSceneService();

    test('时间段映射', () {
      expect(service.getScene(DateTime(2026, 1, 1, 6)), TimeSceneService.morning);
      expect(
          service.getScene(DateTime(2026, 1, 1, 9)), TimeSceneService.forenoon);
      expect(service.getScene(DateTime(2026, 1, 1, 12)), TimeSceneService.lunch);
      expect(service.getScene(DateTime(2026, 1, 1, 15)),
          TimeSceneService.afternoon);
      expect(service.getScene(DateTime(2026, 1, 1, 18)), TimeSceneService.dinner);
      expect(
          service.getScene(DateTime(2026, 1, 1, 20)), TimeSceneService.evening);
      expect(service.getScene(DateTime(2026, 1, 1, 23)),
          TimeSceneService.lateNight);
      expect(service.getScene(DateTime(2026, 1, 1, 2)),
          TimeSceneService.deepNight);
    });

    test('时间段标签', () {
      expect(service.getPeriodLabel(DateTime(2026, 1, 1, 6)), '早晨');
      expect(service.getPeriodLabel(DateTime(2026, 1, 1, 12)), '午间');
    });
  });

  group('DialogueVariableService', () {
    test('变量替换', () {
      final service = DialogueVariableService(TimeSceneService());
      final now = DateTime(2026, 8, 13, 9, 30);
      final result = service.resolve('现在是{aliya_year}年，{current_time}，{time_period}', now);
      expect(result, contains('3026'));
      expect(result, contains('09:30'));
      expect(result, contains('上午'));
    });

    test('未识别变量被移除', () {
      final service = DialogueVariableService(TimeSceneService());
      final result = service.resolve('未知变量{unknown_var}在这里', DateTime(2026, 1, 1));
      expect(result, '未知变量在这里');
    });

    test('aliya_year = player_year + 1000', () {
      final service = DialogueVariableService(TimeSceneService());
      final result = service.resolve('{aliya_year}', DateTime(2026, 1, 1));
      expect(result, '3026');
    });
  });
}

DialogueEntry _entry(String id, String text) =>
    DialogueEntry(id: id, text: text, enabled: true);

class _TestRepository implements DialogueRepository {
  _TestRepository(this.entries, this.selectionMode);

  final List<DialogueEntry> entries;
  final String? selectionMode;

  factory _TestRepository.withEntries(List<DialogueEntry> entries,
      {String? selectionMode}) {
    return _TestRepository(entries, selectionMode);
  }

  @override
  List<DialogueEntry> allEntries = [];

  @override
  List<DialogueEntry> enabledEntries = [];

  @override
  List<String> failedFiles = [];

  @override
  int loadedFileCount = 0;

  @override
  int get totalEntryCount => entries.length;

  @override
  void loadFromDirectory(String rootDirectory) {}

  @override
  List<DialogueEntry> getEnabledEntriesForScene(String scene) =>
      entries.where((e) => e.enabled != false && e.text!.isNotEmpty).toList();

  @override
  DialogueFile? findScene(String scene) => DialogueFile(
        scene: scene,
        selectionMode: selectionMode,
        entries: entries,
      );

  @override
  List<String> getFallbackForScene(String scene) =>
      DialogueRepository.fallbackByScene[scene] ?? const [];
}
