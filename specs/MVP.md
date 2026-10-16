# TÀI LIỆU KIẾN TRÚC & QUY TRÌNH VẬN HÀNH HỆ THỐNG SLP TRÊN PASEO (MVP SPECIFICATION)

Tài liệu này mô tả chi tiết kiến trúc tổng thể, cơ chế vận hành thực tế của hệ thống **SLP (Supervisor – Lead – Peer)** trên nền tảng Paseo, cách quản lý bộ nhớ ngữ cảnh (Context), luồng điều phối `git worktree` và cơ chế kiểm soát giao tiếp qua **Tool-Call Bus**.

---

## 1. Kiến trúc Phân tầng & Ranh giới Trách nhiệm (System Topology)

Hệ thống được chia thành **4 tầng thực thể** và **1 tầng hạ tầng điều phối (Paseo Plugin Daemon)**. Mọi hoạt động sản xuất diễn ra ở hậu trường, đảm bảo nguyên tắc **"Một điểm chạm duy nhất" (Single Point of Contact)** cho người quản lý tối cao.

| Thực thể | Không gian sống (Git & Paseo) | Quyền hạn với Codebase | Trách nhiệm cốt lõi trong hệ thống |
| --- | --- | --- | --- |
| **1. Supreme Manager (Tôi)** | Giao diện chính của Paseo | Phê duyệt cuối cùng (`main`) | Đưa ra yêu cầu nghiệp vụ ban đầu, trả lời các câu hỏi làm rõ cấp chiến lược và duyệt bản gộp cuối cùng từ Supervisor. |
| **2. Supervisor Agent** | Workspace chính (Nhánh `main`) | **Chỉ đọc (Read-Only)** | Dịch yêu cầu của Tôi thành **Tiêu chí nghiệm thu (Acceptance Criteria)** giao cho Master Lead; giám sát quy trình (bắt lỗi lặp vô hạn, lệch phạm vi); độc lập kiểm tra bằng chứng test trước khi báo cáo lại cho Tôi. |
| **3. Master Lead Agent** | Workspace tích hợp (Nhánh `dev`) | Toàn quyền trên nhánh `dev` | Khảo sát codebase, viết **Master Spec**, chia nhỏ dự án thành các gói công việc độc lập (Worktrees), cấu hình số lượng Peer và chặng chạy cho từng gói, hỏi lại Peer khi gặp xung đột lúc gộp code, và chạy kiểm thử tích hợp tổng thể trên nhánh `dev`. |
| **4. Forked Lead (Bản sao tạm thời)** | Phân nhánh trực tiếp từ phiên của Master Lead | **Chỉ đọc (Read-Only)** | Kế thừa 100% trí nhớ (KV Cache) của Master Lead tại thời điểm chốt Spec để giải thích yêu cầu, hỏi đáp và duyệt kế hoạch thực thi với từng Peer mà **không làm rác bộ nhớ của Master Lead**. Tự hủy ngay sau khi Peer bắt đầu viết code. |
| **5. Hệ thống Peers (Implementer, QA, Security, Doc)** | Các `git worktree` ẩn (`--background`) tách từ nhánh `dev` | Giới hạn chặt theo danh sách thư mục cấp phép (`writable_scope`) | Thực thi chuyên sâu từng khâu trên nhánh riêng: đối chiếu giả định với code thật, viết code, kiểm thử, rà soát bảo mật, sửa lỗi nội bộ và xuất hồ sơ nghiệm thu (`ACCEPTANCE_DOC.md`). |
| **6. Paseo Plugin Daemon (Trạm kiểm soát ngầm)** | Tiến trình nền của Paseo | Kiểm soát vật lý hệ thống file & Git | Tự động tiêm bộ công cụ giao tiếp (MCP Tool-Bus), định tuyến tin nhắn giữa các Agent, cưỡng chế khóa quyền ghi file, đếm số vòng lặp sửa lỗi và ghi nhật ký toàn bộ hoạt động để phục vụ Debug. |

---

## 2. Ba Cơ chế Hạ tầng Cốt lõi (Cách hệ thống thực sự hoạt động bên dưới)

### 2.1. Cơ chế "Zero-CLI-Send": Giao tiếp độc quyền qua MCP Tool-Bus

Các Agent (dù chạy trên Claude Code, Codex, Antigravity hay Pi) **bị tước quyền gọi lệnh gửi tin nhắn tự do** qua terminal. Thay vào đó, trước khi bất kỳ tiến trình CLI nào khởi chạy, Paseo Plugin tự động gắn một **Trạm Giao tiếp Nội bộ (MCP Broker)** vào phiên làm việc của Agent đó:

* Mỗi Agent chỉ nhìn thấy đúng các hàm công cụ (Tool Calls) tương ứng với vai trò của mình.
* Khi Agent A muốn nói chuyện với Agent B, Agent A phải gọi hàm công cụ có cấu trúc dữ liệu cố định.
* Lời gọi này đi vào **Plugin Daemon** trước tiên. Tại đây, Daemon kiểm tra: *Agent A có quyền gọi Agent B không? Có vượt quá số lần tranh luận cho phép không? Nội dung có vi phạm hợp đồng thiết kế không?*
* Nếu hợp lệ, Daemon ghi lại toàn bộ gói tin vào nhật ký giám sát (Audit Log), sau đó mới chuyển thông điệp sang đánh thức Agent B.

### 2.2. Cơ chế Nhân bản Ngữ cảnh Gốc (Native CLI Session Forking)

Để giữ cho bộ nhớ của **Master Lead** luôn tinh gọn từ đầu đến cuối dự án:

* Khi Master Lead khảo sát xong mã nguồn và lập xong bản **Master Spec**, trạng thái phiên làm việc của CLI tại thời điểm đó được đánh dấu làm **Điểm gốc (Checkpoint)**.
* Với mỗi nhánh công việc (`git worktree`) được tạo ra, Plugin Daemon can thiệp vào quá trình khởi tạo của Paseo để **tách nhánh phiên làm việc trực tiếp từ Điểm gốc** của Master Lead thành các **Forked Lead**.
* Nhờ cơ chế lưu trữ dạng cây của các CLI hiện đại, các **Forked Lead** sở hữu ngay lập tức toàn bộ kiến thức nền và bộ nhớ đệm (Prompt Cache) của Master Lead mà không tốn thời gian đọc lại dự án, đồng thời mọi cuộc hội thoại giải thích chi tiết với Peer đều nằm ở nhánh riêng, không ghi đè vào lịch sử của Master Lead.

### 2.3. Cơ chế "Worktree là một Dây chuyền" (Worktree-Centric DAG Pipeline)

Thay vì mỗi Peer một thư mục rời rạc hoặc tất cả làm chung một chỗ gây đụng độ file:

* Mỗi nhiệm vụ con được cấp một **Paseo Workspace ẩn** gắn với một **Git Worktree riêng biệt** tách ra từ nhánh `dev`.
* Nhiều Peer (Implementer, QA, Security, Doc) cùng được khởi tạo bên trong một Worktree này nhưng **hoạt động theo từng Chặng (Stages)** do Master Lead định nghĩa.
* Giữa các Chặng là **chạy tuần tự tiếp sức** (Chặng trước xong mới mở Chặng sau). Bên trong một Chặng có thể cấu hình **chạy đơn lẻ** (khi có quyền ghi code) hoặc **chạy song song cùng lúc** (khi nhiều Peer chỉ đọc code để kiểm tra chất lượng và bảo mật).

---

## 3. Luồng Vận hành Chi tiết 6 Giai đoạn (End-to-End Workflow)

### Giai đoạn 1: Khởi phát & Chốt Tiêu chí (Tôi $\leftrightarrow$ Supervisor $\rightarrow$ Master Lead)

1. **Tôi** gửi yêu cầu tính năng cho **Supervisor**.
2. **Supervisor** phân tích, hỏi lại Tôi nếu có điểm mờ về nghiệp vụ, sau đó lập bảng **Tiêu chí Nghiệm thu Tổng thể** và gọi công cụ ủy quyền dự án xuống cho **Master Lead** (đang đứng ở nhánh `dev`).
3. **Master Lead** đọc cấu trúc mã nguồn hiện tại trên nhánh `dev`, thiết kế kiến trúc tổng thể (**Master Spec**), xác định rõ cấu trúc dữ liệu chung (Interfaces/Contracts) và chia dự án thành các gói công việc không chồng lấn phạm vi file.

### Giai đoạn 2: Khởi tạo Worktree & Pha 0 "Bắt tay Nhận thức" (Forked Lead $\leftrightarrow$ Implementer Peer)

Với mỗi gói công việc, **Master Lead** gọi công cụ khởi tạo Worktree kèm theo cấu hình các chặng Peer. Ngay lập tức, Plugin Daemon thực hiện:

1. Tạo một `git worktree` mới tách từ nhánh `dev` (chạy ở chế độ ẩn để không làm loạn màn hình của Tôi) và đặt bản đặc tả nhiệm vụ (`TASK_SPEC.md`) vào đó. Bản đặc tả này ghi rõ: *Mục đích, Các giả định của Lead về code hiện tại, Ranh giới thư mục được sửa, và Những việc cấm làm*.
2. Nhân bản phiên làm việc của Master Lead ra một **Forked Lead** chuyên trách nhánh này.
3. Khởi tạo **Implementer Peer** bên trong Worktree đó nhưng **khóa ở chế độ Chỉ Đọc (Plan Mode)**.
4. **Thực hiện "Bắt tay Ngược" (Readback Handshake):**
* **Implementer Peer** đọc đặc tả của Lead, mở các file code thực tế trong Worktree ra đối chiếu xem giả định của Lead có khớp với code thật không.
* **Implementer Peer** gọi công cụ nộp **Bản Diễn giải & Kế hoạch Thực thi** (gồm: tóm tắt lại mục tiêu bằng lời của mình, báo cáo những điểm code thực tế khác với giả định của Lead, và danh sách chính xác các file/hàm dự kiến sửa).
* **Forked Lead** đọc bản kế hoạch này:
* Nếu Peer hiểu sai hoặc hỏi thêm: **Forked Lead** trực tiếp giải thích và nắn chỉnh cho đến khi khớp.
* Nếu phát hiện giả định ban đầu trong Master Spec bị sai nghiêm trọng làm ảnh hưởng tới các nhánh khác: **Forked Lead** gửi yêu cầu xin điều chỉnh Spec về cho **Master Lead (Bản chính)** quyết định.
* Khi kế hoạch của Peer đã chuẩn xác 100%: **Forked Lead** gọi công cụ **Xác nhận Đồng thuận**.




5. **Mở khóa & Thu hồi:** Ngay khi có lệnh Xác nhận Đồng thuận, Plugin Daemon gửi một bản tóm tắt siêu ngắn về cho Master Lead nắm tình hình, **tự động hủy tiến trình Forked Lead**, và chuyển **Implementer Peer** sang **Chế độ Thực thi ( mở khóa quyền ghi trong phạm vi thư mục được cấp)**.

### Giai đoạn 3: Thực thi & Kiểm định đa tầng trong Worktree (Hệ thống Peers hoạt động)

Khi **Implementer Peer** được mở khóa quyền ghi, dây chuyền các chặng trong Worktree bắt đầu chạy dưới sự giám sát của Plugin Daemon:

1. **Chặng Thực thi (Implementation Stage):**
* **Implementer Peer** viết code và unit test cơ bản theo đúng bản kế hoạch đã chốt.
* Khi hoàn tất, nó commit code vào nhánh Worktree và gọi công cụ báo cáo hoàn thành chặng.
* **Chốt chặn Vật lý của Daemon:** Plugin Daemon tự động kiểm tra danh sách file vừa thay đổi trên Git. Nếu phát hiện bất kỳ file nào nằm ngoài danh sách thư mục được cấp phép (`writable_scope`) hoặc file `TASK_SPEC.md` bị sửa đổi, Daemon từ chối kết quả ngay lập tức và bắt Implementer Peer khôi phục lại.
* Sau khi hợp lệ, **Implementer Peer** chuyển sang trạng thái **Nghỉ chờ (Idle)** — tiến trình dừng tiêu thụ tài nguyên nhưng toàn bộ trí nhớ phiên làm việc vẫn được giữ nguyên trên ổ đĩa.


2. **Chặng Kiểm định Song song / Nối tiếp (Verification Stage):**
* Tuỳ theo cấu hình của Master Lead cho nhiệm vụ này, Plugin Daemon tự động đánh thức đồng thời (hoặc lần lượt) **QA Peer** và **Security Peer** nhảy vào **cùng thư mục Worktree đó**.
* **QA Peer** (chỉ có quyền ghi trong thư mục `tests/`) đọc đặc tả nhiệm vụ, viết thêm các kịch bản kiểm thử góc khuất (edge-cases) và chạy bộ test thực tế.
* **Security Peer** (chế độ Chỉ Đọc hoàn toàn) rà soát toàn bộ phần code mới viết để tìm lỗ hổng bảo mật, rò rỉ dữ liệu hoặc vi phạm kiến trúc.


3. **Vòng lặp Tự sửa lỗi Nội bộ (Intra-Worktree Fix Loop):**
* Nếu cả QA và Security đều gọi công cụ xác nhận **ĐẠT (APPROVED)** $\rightarrow$ Chuyển sang bước Chốt hồ sơ.
* Nếu bất kỳ ai trả về **KHÔNG ĐẠT (REJECTED)** kèm danh sách lỗi $\rightarrow$ Plugin Daemon gom toàn bộ biên bản lỗi của chặng đó, tăng bộ đếm vòng lặp lên 1, và **đánh thức ông Implementer Peer dậy để sửa lỗi**. Khi Implementer sửa xong, QA và Security lại được gọi vào kiểm tra lại.


4. **Chặng Chốt Hồ sơ Nghiệm thu (Documentation Stage):**
* Khi mọi kiểm định đều ĐẠT, Plugin Daemon đánh thức lại chính **Implementer Peer** (tận dụng trí nhớ sẵn có của nó) hoặc một **Doc Peer** để tổng hợp toàn bộ kết quả: *Tính năng đã làm, danh sách file thay đổi, lý do của các quyết định kỹ thuật quan trọng, kết quả chạy test của QA và biên bản bảo mật của Security* vào file `.slp/ACCEPTANCE_DOC.md`.
* Plugin Daemon kiểm tra file `.slp/ACCEPTANCE_DOC.md` đã tồn tại và hợp lệ $\rightarrow$ Đánh dấu Worktree này sang trạng thái **Sẵn sàng Gộp (Ready for Merge)** và gửi thông báo về cho **Master Lead**.



### Giai đoạn 4: Hợp nhất Có Tham vấn Ngữ cảnh (Master Lead $\leftrightarrow$ Implementer Peer)

Khi nhận thông báo một nhánh Worktree đã sẵn sàng:

1. **Master Lead** (đang ở nhánh `dev`) đọc trước file `.slp/ACCEPTANCE_DOC.md` của nhánh đó để nắm toàn bộ bức tranh kỹ thuật mà không cần đọc mò từng dòng code.
2. **Master Lead** thực hiện lệnh gộp nhánh (`git merge`) từ Worktree đó vào nhánh `dev`.
3. **Cơ chế Tham vấn khi gặp Xung đột (Interactive Conflict Consultation):**
* Nếu quá trình gộp nhánh trơn tru hoặc chỉ có xung đột cú pháp đơn giản: Master Lead tự giải quyết luôn.
* Nếu gặp xung đột logic phức tạp với một nhánh khác vừa gộp trước đó, hoặc thấy một đoạn code chưa rõ ý đồ: **Master Lead tự suy luận ra câu hỏi** và gọi công cụ **Tham vấn Peer** (`slp_consult_peer`) trỏ thẳng tới **Implementer Peer** của nhánh đó.
* Vì **Implementer Peer** ở Giai đoạn 3 vẫn đang được giữ ở trạng thái Nghỉ chờ (chưa bị xóa), nó được đánh thức dậy với đầy đủ ký ức lúc viết đoạn code đó và giải thích chính xác cho Master Lead tại sao nó làm như vậy và cách gộp an toàn nhất.


4. Sau khi **Master Lead** hiểu rõ 100% và hoàn tất việc gộp code sạch sẽ vào nhánh `dev`, Master Lead phát lệnh cho Plugin Daemon **Đóng băng và Lưu trữ (Archive)** cái Worktree kia đi, chính thức kết thúc vòng đời của các Peer trong nhánh đó.

### Giai đoạn 5: Tổng Nghiệm thu & Phản biện Toàn cục trên nhánh `dev`

Khi tất cả các nhánh công việc con đã được gộp hết về nhánh `dev`:

1. **Master Lead** (hoặc một **Final Audit Peer** độc lập được Master Lead gọi ra trên nhánh `dev`) chạy toàn bộ bộ kiểm thử tích hợp (Integration / End-to-End Tests) của toàn dự án.
2. Thực hiện **Phản biện Kỹ thuật & Tính năng lần cuối**: Kiểm tra xem khi ghép các nhánh A, B, C lại với nhau có tạo ra hiệu ứng phụ, nghẽn hiệu năng, hay bỏ sót yêu cầu nào trong bản Tiêu chí Nghiệm thu ban đầu của Supervisor hay không.
3. Khi nhánh `dev` đã hoàn toàn ổn định, **Master Lead** đóng gói báo cáo tổng hợp kèm đường dẫn tới các hồ sơ `ACCEPTANCE_DOC.md` và gửi lên cho **Supervisor**.

### Giai đoạn 6: Kiểm toán Độc lập & Báo cáo cho Tôi (Supervisor $\rightarrow$ Supreme Manager)

1. **Supervisor** nhận báo cáo từ Master Lead, tự mình kiểm tra chéo với bảng Tiêu chí Nghiệm thu ban đầu (xem log chạy test thực tế trên nhánh `dev`, kiểm tra `git diff` tổng thể).
2. Nếu phát hiện thiếu sót, Supervisor trả ngược về cho Master Lead xử lý bổ sung.
3. Nếu đạt 100%, **Supervisor** trình bày một bản báo cáo tinh gọn, rõ ràng lên kênh chat duy nhất với **Tôi** để Tôi xem xét và ấn nút phê duyệt đưa vào nhánh `main`.

---

## 4. Quy tắc Giao tiếp Ngang hàng & 4 Chốt chặn Chống Vượt quyền

Để hệ thống Peer vừa có thể phối hợp linh hoạt vừa không bao giờ tự ý làm loạn kiến trúc, **Trạm Giao tiếp của Plugin Daemon** áp dụng 4 luật cứng:

1. **Giao tiếp Liên Nhánh (Giữa Peer của Worktree A và Peer của Worktree B) chỉ được phép Hỏi Thông tin (Read-Only Query):**
* Khi Peer ở nhánh A cần biết chi tiết một hàm hay mã lỗi mà Peer ở nhánh B đang làm, nó gọi công cụ `slp_ask_sibling_worktree`.
* Plugin Daemon tự động chèn một chỉ thị khóa quyền vào câu hỏi trước khi chuyển sang nhánh B: *Chỉ được phép trả lời sự thật về code hiện tại, nghiêm cấm tự ý sửa code hay thỏa thuận thay đổi thiết kế theo lời của nhánh khác*.


2. **Tự động Đẩy lên Cấp trên khi Đụng chạm Hợp đồng Thiết kế (Contract Escalation):**
* Nếu trong lúc hai Peer trao đổi (hoặc khi QA kiểm tra code của Implementer) mà phát hiện ra thiết kế giao tiếp (API schema, cấu trúc bảng DB) trong `TASK_SPEC.md` không thể thực hiện được hoặc bị lệch giữa hai nhánh:
* Không một Peer nào có quyền tự quyết. Công cụ giao tiếp sẽ chặn cuộc thảo luận ngang hàng đó lại và **tự động chuyển hướng (Escalate) vấn đề thẳng lên cho Master Lead** phán xử.


3. **Cầu chì Ngắt mạch Vòng lặp (Circuit Breaker — Tối đa 3 vòng):**
* Trong một Worktree, nếu ông QA/Security và ông Implementer cứ trả đi trả lại lỗi quá **3 lần** (`fixLoopCount > 3`) mà vẫn chưa được duyệt `APPROVED`, Plugin Daemon tự động ngắt quyền trao đổi nội bộ của nhóm Peer đó, tạm dừng Worktree và bắn cảnh báo khẩn cấp về cho **Master Lead** vào cuộc giải quyết.


4. **Cô lập Quyền Ghi theo Từng Vai trò trong Cùng Worktree:**
* Dù sống chung trong một thư mục Worktree, tại một thời điểm chỉ có một nhóm vai trò được hoạt động. Ông Implementer chỉ được sửa code ứng dụng (`src/`), ông QA chỉ được sửa/thêm file kiểm thử (`tests/`), ông Security hoàn toàn không có quyền sửa bất kỳ file nào.



---

## 5. Cơ chế Giám sát, Debug & Tinh chỉnh Quy trình (Observability & Tuning)

Để Tôi kiểm soát xem tất cả các bước ngầm có đang chạy đúng ý mình hay không và dễ dàng tinh chỉnh cho từng dự án, hệ thống cung cấp **3 cấp độ vận hành** và **3 công cụ quan sát trực tiếp**:

### 3 Chế độ Vận hành (Có thể chuyển đổi tức thì)

1. **Chế độ Từng Bước (`STEP_BY_STEP_DEBUG` — Dùng khi mới áp dụng vào dự án):**
* Sau mỗi bước chuyển giao (ví dụ: *Bắt tay xong*, *Implementer code xong*, *QA test xong*, *Trước khi gộp nhánh*), hệ thống **tự động tạm dừng** và hiện thông báo trên bảng điều khiển.
* Tôi có thể mở Worktree ẩn đó lên xem file, đọc nhật ký hội thoại giữa các Agent, nắn chỉnh lại câu lệnh hướng dẫn (Prompt) nếu thấy Agent hiểu chưa sát, rồi bấm nút **"Duyệt & Chạy bước tiếp theo"**.


2. **Chế độ Bán Tự động (`SEMI_AUTO`):**
* Toàn bộ quá trình bên trong Worktree (từ Bắt tay $\rightarrow$ Code $\rightarrow$ QA/Security $\rightarrow$ Viết tài liệu nghiệm thu) chạy tự động hoàn toàn. Hệ thống chỉ dừng lại chờ kiểm tra khi có cảnh báo vượt quá 3 vòng lặp lỗi hoặc trước khi Master Lead gộp code vào nhánh `dev`.


3. **Chế độ Tự động Hoàn toàn (`FULL_AUTO`):**
* Khi các bước đã được tinh chỉnh mượt mà, toàn bộ dây chuyền chạy khép kín từ lúc Tôi giao việc cho Supervisor đến khi nhận báo cáo nghiệm thu cuối cùng.



### 3 Công cụ Quan sát để Tinh chỉnh (Debug Tools)

1. **Bảng Nhật ký Giao tiếp Trực tiếp (Live Tool-Call Monitor Panel):** Một tab giao diện nằm ngay trong Paseo hiển thị theo thời gian thực mọi lượt gọi công cụ giữa các Agent (*Ai vừa gửi tin cho ai, thuộc Worktree nào, tóm tắt nội dung là gì, được chuyển đi hay bị chặn bởi chốt chặn an toàn*).
2. **Thẻ Tiến độ Trực tiếp trên Kênh của Supervisor (In-Chat Progress Cards):** Mỗi Worktree được biểu diễn bằng một thẻ trạng thái ngay trong luồng chat của Supervisor, tự động đổi màu và cập nhật khi nhánh đó đi qua từng chặng (`Đang bắt tay` $\rightarrow$ `Đang viết code` $\rightarrow$ `Đang kiểm thử (Vòng 1/3)` $\rightarrow$ `Đã gộp vào dev`).
3. **Hộp đen Lưu vết (`.slp/comm-log.jsonl`):** Toàn bộ đầu vào, đầu ra, thời gian xử lý và lý do bị từ chối ở từng chặng được lưu lại thành file lịch sử trong dự án, giúp Tôi dễ dàng đối chiếu xem khâu nào trong dây chuyền đang hoạt động kém hiệu quả nhất để tối ưu hóa.