import '../../models/interaction/interaction_state.dart';

/// 当日互动状态服务（跨天自动清零）。
class InteractionStateService {
  final InteractionState _state = InteractionState();

  InteractionState get state => _state;

  void ensureFresh() => _state.ensureDayFresh();

  void beginPetting() => _state.beginPetting(DateTime.now());

  void endPetting(int durationMs) => _state.endPetting(durationMs);

  int get pettingCountToday => _state.headPettingCountToday;

  bool wasRecentlyUsed(String id) => _state.wasRecentlyUsed(id);

  void recordDialogueId(String id) => _state.recordDialogueId(id);
}
